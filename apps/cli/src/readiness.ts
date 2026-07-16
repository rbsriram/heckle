import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { createInterface } from "node:readline/promises";
import type { HeckleConfig } from "../../../packages/shared/src/index.ts";
import { defaultWhich } from "../../../packages/delivery/src/agent-dispatch.ts";
import type { SpawnFn, WhichFn } from "../../../packages/delivery/src/types.ts";
import { chromium } from "playwright";

export interface OllamaReadiness {
  state: "ready" | "missing-model" | "unreachable";
  models: string[];
  detail?: string;
}

export interface AgentReadiness {
  agent: "claude-code" | "cursor" | "codex";
  binary: string;
  available: boolean;
}

export interface ReadinessOptions {
  interactive?: boolean;
  skipModelCheck?: boolean;
  fetchFn?: typeof fetch;
  whichFn?: WhichFn;
  spawnFn?: SpawnFn;
  confirm?: (question: string) => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  browserExecutablePath?: () => string;
  existsFn?: (path: string) => boolean;
}

const AGENTS: Array<{ agent: AgentReadiness["agent"]; binary: string }> = [
  { agent: "claude-code", binary: "claude" },
  { agent: "cursor", binary: "cursor-agent" },
  { agent: "codex", binary: "codex" },
];

export function assertSupportedNode(version: string = process.version): void {
  const major = Number(version.replace(/^v/, "").split(".")[0]);
  if (!Number.isInteger(major) || major < 24) {
    throw new Error(`Node 24 or newer is required (found ${version}). Install Node 24, then run Heckle again.`);
  }
}

function ollamaHost(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "");
}

function modelMatches(installed: string, wanted: string): boolean {
  if (installed === wanted) return true;
  if (!wanted.includes(":")) return installed === `${wanted}:latest`;
  return false;
}

function isLoopbackUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

export async function inspectOllama(
  baseUrl: string,
  model: string,
  fetchFn: typeof fetch = fetch,
): Promise<OllamaReadiness> {
  try {
    const res = await fetchFn(`${ollamaHost(baseUrl)}/api/tags`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return { state: "unreachable", models: [], detail: `HTTP ${res.status}` };
    const body = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
    const models = (body.models ?? []).map((m) => m.name ?? m.model ?? "").filter(Boolean);
    return models.some((installed) => modelMatches(installed, model))
      ? { state: "ready", models }
      : { state: "missing-model", models };
  } catch (err) {
    return { state: "unreachable", models: [], detail: (err as Error).message };
  }
}

export async function inspectAgents(whichFn: WhichFn = defaultWhich): Promise<AgentReadiness[]> {
  return Promise.all(AGENTS.map(async ({ agent, binary }) => ({ agent, binary, available: await whichFn(binary) })));
}

export function isPortAvailable(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

async function defaultConfirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function pullModel(model: string, spawnFn: SpawnFn): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnFn("ollama", ["pull", model], { stdio: "inherit" });
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    child.on?.("error", fail);
    child.on?.("exit", (value) => {
      if (settled) return;
      settled = true;
      const code = typeof value === "number" ? value : null;
      if (code === 0) resolve();
      else reject(new Error(`ollama pull exited ${code ?? "without a status"}`));
    });
  });
}

export async function runReadiness(config: HeckleConfig, options: ReadinessOptions = {}): Promise<AgentReadiness[]> {
  assertSupportedNode();
  const log = options.log ?? console.log;
  const whichFn = options.whichFn ?? defaultWhich;
  const agents = await inspectAgents(whichFn);
  if (config.privacy.localOnly && (config.drafting.provider !== "ollama" || !isLoopbackUrl(config.drafting.baseUrl))) {
    throw new Error("local-only mode requires Ollama on a loopback URL. Fix heckle.config.ts before starting.");
  }
  log(`[heckle] Node ${process.versions.node} ready`);
  const browserPath = (options.browserExecutablePath ?? (() => chromium.executablePath()))();
  if (!(options.existsFn ?? existsSync)(browserPath)) {
    throw new Error("Chromium is required for replay verification. Run `npx playwright@1.61.1 install chromium`, then start Heckle again.");
  }
  log("[heckle] replay: Chromium ready");
  log(`[heckle] agents: ${agents.map((a) => `${a.agent}=${a.available ? "ready" : "missing"}`).join(" ")}`);

  const route = config.delivery.order.find(
    (name): name is AgentReadiness["agent"] => name === "claude-code" || name === "cursor" || name === "codex",
  );
  const selected = route ? agents.find((a) => a.agent === route) : undefined;
  if (!selected || !selected.available) {
    log("[heckle] delivery: file inbox fallback is active; install or select an available agent for automatic fixes");
  } else {
    log(`[heckle] delivery: ${selected.agent} (${selected.binary}) with file inbox fallback`);
  }

  if (config.drafting.provider !== "ollama" || options.skipModelCheck) {
    if (options.skipModelCheck) {
      log("[heckle] model readiness check skipped explicitly");
    } else {
      const keyEnv = `${config.drafting.provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
      const needsKey = config.drafting.provider === "anthropic";
      if (needsKey && !(options.env ?? process.env)[keyEnv]) {
        throw new Error(`${config.drafting.provider}:${config.drafting.model} requires ${keyEnv}. Set it with \`heckle config key ${config.drafting.provider} <key>\`.`);
      }
      log(`[heckle] drafting: ${config.drafting.provider}:${config.drafting.model} configured`);
    }
    return agents;
  }

  const ollama = await inspectOllama(config.drafting.baseUrl, config.drafting.model, options.fetchFn ?? fetch);
  if (ollama.state === "ready") {
    log(`[heckle] drafting: Ollama ${config.drafting.model} ready (local only)`);
    return agents;
  }
  if (ollama.state === "unreachable") {
    throw new Error(
      `Ollama is not reachable at ${ollamaHost(config.drafting.baseUrl)}${ollama.detail ? ` (${ollama.detail})` : ""}. Start Ollama, or configure a cloud model with \`heckle config model\`.`,
    );
  }

  const interactive = options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) {
    throw new Error(
      `Ollama model ${config.drafting.model} is missing. Run \`ollama pull ${config.drafting.model}\`, or use --skip-model-check after configuring drafting explicitly.`,
    );
  }
  if (!(await whichFn("ollama"))) {
    throw new Error(`Ollama model ${config.drafting.model} is missing and the ollama command is not on PATH.`);
  }
  const confirm = options.confirm ?? defaultConfirm;
  if (!(await confirm(`Pull Ollama model ${config.drafting.model} now?`))) {
    throw new Error(`Ollama model ${config.drafting.model} is required. Run \`ollama pull ${config.drafting.model}\` when ready.`);
  }
  await pullModel(config.drafting.model, options.spawnFn ?? ((cmd, args, opts) => nodeSpawn(cmd, [...args], opts)));
  const after = await inspectOllama(config.drafting.baseUrl, config.drafting.model, options.fetchFn ?? fetch);
  if (after.state !== "ready") throw new Error(`Ollama model ${config.drafting.model} was not available after the pull completed.`);
  log(`[heckle] drafting: Ollama ${config.drafting.model} ready (local only)`);
  return agents;
}

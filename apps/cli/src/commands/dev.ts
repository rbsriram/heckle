import { type ChildProcess, spawn } from "node:child_process";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { startInjectingProxy } from "@heckle/daemon";
import { type AgentKind, hasAgentContext, hasAnyAgentContext, installAgentContext } from "@heckle/delivery";

// Resolve the daemon entry point relative to THIS file, so it works no matter the cwd
// or how `heckle` was invoked (npm bin symlink, npx, or direct node).
const DAEMON_ENTRY = fileURLToPath(new URL("../../../../packages/daemon/src/main.ts", import.meta.url));

interface DevArgs {
  wrapped: string[];
  noProxy: boolean;
  appUrl?: string;
  uiPort: number;
  noInit: boolean;
  agent?: AgentKind;
}

const AGENTS: AgentKind[] = ["claude-code", "cursor", "codex", "all"];

function parseArgs(args: string[]): DevArgs {
  const dd = args.indexOf("--");
  const flags = dd === -1 ? [] : args.slice(0, dd);
  const wrapped = dd === -1 ? args : args.slice(dd + 1);
  const out: DevArgs = { wrapped, noProxy: false, uiPort: Number(process.env.HECKLE_UI_PORT ?? 4318), noInit: false };
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === "--no-proxy") out.noProxy = true;
    else if (flags[i] === "--no-init") out.noInit = true;
    else if (flags[i] === "--app-url") out.appUrl = flags[++i];
    else if (flags[i] === "--ui-port") out.uiPort = Number(flags[++i]);
    else if (flags[i] === "--agent") {
      const a = flags[++i];
      if (a === undefined || !AGENTS.includes(a as AgentKind)) {
        // Silently dropping a typo ("codx") would auto-init the wrong agent on a fresh project.
        console.error(`heckle dev: unknown --agent "${a ?? ""}" (expected: ${AGENTS.join(" | ")})`);
        process.exit(1);
      }
      out.agent = a as AgentKind;
    }
  }
  return out;
}

function rel(p: string): string {
  const cwd = process.cwd();
  return p.startsWith(cwd) ? p.slice(cwd.length + 1) : p;
}

/**
 * First-run onboarding: teach the coding agent about Heckle so "check Heckle" and the
 * auto-dispatch work without a separate `heckle init` step. Idempotent and silent once
 * present. With no `--agent`, we only act when NO agent has been taught yet (true first run);
 * with an explicit `--agent`, we install that agent if it is missing.
 */
function autoInit(opts: DevArgs): void {
  if (opts.noInit) return;
  const explicit = opts.agent !== undefined;
  const agent: AgentKind = opts.agent ?? "claude-code";
  const already = explicit ? hasAgentContext(process.cwd(), agent) : hasAnyAgentContext(process.cwd());
  if (already) return;
  const res = installAgentContext(process.cwd(), agent);
  for (const p of res.written) console.log(`[heckle] taught your agent: ${rel(p)}`);
  console.log(`[heckle] agent context installed for ${agent} (first run). Use 'heckle init' for others.\n`);
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch {
      // daemon not up yet
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`daemon did not become healthy at ${url} within ${timeoutMs}ms`);
}

/**
 * `heckle dev [--no-proxy] [--app-url <url>] [--ui-port <n>] -- <command>`
 * Starts the daemon, runs the wrapped dev command, and (by default) stands up an injecting
 * proxy in front of it so the widget attaches with zero changes to the project. It discovers
 * the dev server's URL from the command's own output, or takes it from --app-url.
 */
export async function runDev(args: string[]): Promise<void> {
  const opts = parseArgs(args);
  if (opts.wrapped.length === 0) {
    console.error("heckle dev: provide a command after --\n\n  e.g. heckle dev -- npm run dev");
    process.exitCode = 1;
    return;
  }

  autoInit(opts);

  const port = Number(process.env.HECKLE_PORT ?? 4317);
  const daemonUrl = `http://127.0.0.1:${port}`;

  // 1) Start the daemon as its own process.
  const daemon = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", DAEMON_ENTRY], {
    stdio: "inherit",
    env: { ...process.env, HECKLE_PORT: String(port) },
  });

  let shuttingDown = false;
  let proxy: Server | null = null;
  const stopDaemon = () => {
    if (!daemon.killed) daemon.kill("SIGTERM");
  };

  try {
    await waitForHealth(daemonUrl, 5000);
  } catch (err) {
    stopDaemon();
    throw err;
  }

  // 2) The injecting proxy: attach the widget to any app with no project changes.
  const startProxy = (appPort: number) => {
    if (proxy || appPort === port || appPort === opts.uiPort) return;
    const snippet = `<script src="${daemonUrl}/heckle.js"></script>`;
    try {
      proxy = startInjectingProxy({ listenPort: opts.uiPort, targetHost: "127.0.0.1", targetPort: appPort, snippet });
      proxy.on("error", (e: Error) => {
        console.error(`[heckle] proxy could not bind ${opts.uiPort}: ${e.message} (try --ui-port <n>, or --no-proxy)`);
        proxy = null;
      });
      console.log(
        `\n[heckle] Open your app with Heckle at:  http://localhost:${opts.uiPort}` +
          `\n[heckle] (dev server on ${appPort}; the widget is injected through the proxy)\n`,
      );
    } catch (e) {
      console.error(`[heckle] proxy failed: ${(e as Error).message}`);
    }
  };

  console.log(`[heckle] attached, daemon ${daemonUrl}`);
  console.log(`[heckle] running: ${opts.wrapped.join(" ")}\n`);

  // 3) Run the user's dev command. Tee its output so we can find the dev server URL.
  const child: ChildProcess = spawn(opts.wrapped[0], opts.wrapped.slice(1), {
    stdio: ["inherit", "pipe", "pipe"],
    env: { ...process.env, HECKLE_DAEMON_URL: daemonUrl },
  });
  child.stdout?.pipe(process.stdout);
  child.stderr?.pipe(process.stderr);

  if (!opts.noProxy) {
    if (opts.appUrl) {
      const m = opts.appUrl.match(/:(\d+)/);
      if (m) startProxy(Number(m[1]));
    } else {
      const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/;
      const scan = (chunk: Buffer) => {
        if (proxy) return;
        const m = chunk.toString().match(URL_RE);
        if (m) startProxy(Number(m[1]));
      };
      child.stdout?.on("data", scan);
      child.stderr?.on("data", scan);
    }
  }

  const finish = (code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    proxy?.close();
    stopDaemon();
    process.exit(code);
  };

  child.on("exit", (code, signal) => finish(code ?? (signal ? 1 : 0)));
  child.on("error", (err) => {
    console.error(`[heckle] failed to start command: ${err.message}`);
    finish(1);
  });

  // Forward termination signals to the child; its exit drives shutdown.
  const forward = (signal: NodeJS.Signals) => () => {
    if (child.pid && !child.killed) child.kill(signal);
  };
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGTERM", forward("SIGTERM"));
}

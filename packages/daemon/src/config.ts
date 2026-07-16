import type { HeckleConfig } from "../../shared/src/index.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Local-first defaults, used when no heckle.config.ts is present in the project root.
export const DEFAULT_CONFIG: HeckleConfig = {
  drafting: {
    provider: "ollama",
    model: "qwen3:14b",
    baseUrl: "http://localhost:11434/v1",
  },
  voice: { provider: "local" },
  delivery: {
    order: ["claude-code", "file-inbox", "clipboard"],
    claudeCode: {
      // One accumulating conversation across fixes (id kept in .heckle/claude-session-id).
      session: "persistent",
      // Edits land unprompted (approval was the gate); the allowlist lets the fix verify itself.
      permissionMode: "acceptEdits",
      allowedTools: [
        "Edit",
        "Write",
        "Read",
        "Bash(npm test:*)",
        "Bash(npm run test:*)",
        "Bash(npm run build:*)",
        "Bash(npm run typecheck:*)",
        "Bash(npm run lint:*)",
        "Bash(pnpm test:*)",
        "Bash(pnpm run:*)",
        "Bash(yarn test:*)",
        "Bash(node --test:*)",
      ],
    },
    // Cursor (`cursor-agent`) and Codex (`codex`) are opt-in: add "cursor" or "codex" to `order`
    // above to route fixes there instead of Claude Code. These are their default postures.
    cursor: {
      session: "persistent", // one owned chat (minted via create-chat) so fixes accumulate
      force: true, // required for edits to land in headless mode
    },
    codex: {
      session: "fresh", // Codex has no client-supplied id; "continue" resumes the newest here
      sandbox: "workspace-write",
      askForApproval: "never", // a prompt would fail the non-interactive run
      skipGitRepoCheck: true,
    },
  },
  agent: "claude-code",
  memory: { embedProvider: "ollama", embedModel: "nomic-embed-text" },
  privacy: { localOnly: true },
  ambient: {
    ignore: ["analytics", "source-map", "sourcemap", "favicon.ico"],
    performance: { cls: false, longTasks: false, hydration: false },
  },
};

// The user-writable config layer, set via `heckle config` or the widget gear so people configure
// the drafting model / voice / keys without editing heckle.config.ts. It lives in the home dir, so
// it is set once and applies to every project. `env` holds provider API keys, kept out of any repo.
export interface UserConfig {
  config: Partial<HeckleConfig>;
  env: Record<string, string>;
}

// ~/.heckle/config.json, or $HECKLE_CONFIG_DIR/config.json (lets you relocate it, and keeps tests
// off the real home dir). Resolved per call so the env override always takes effect.
export function userConfigDir(): string {
  return process.env.HECKLE_CONFIG_DIR || resolve(homedir(), ".heckle");
}
export function userConfigPath(): string {
  return resolve(userConfigDir(), "config.json");
}

export function loadUserConfig(): UserConfig {
  try {
    const path = userConfigPath();
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      const { env, ...config } = raw ?? {};
      return { config: config as Partial<HeckleConfig>, env: (env as Record<string, string>) ?? {} };
    }
  } catch {
    // corrupt / unreadable: behave as if there is no user config
  }
  return { config: {}, env: {} };
}

export function saveUserConfig(u: UserConfig): void {
  mkdirSync(userConfigDir(), { recursive: true });
  const out = { ...u.config, ...(Object.keys(u.env).length ? { env: u.env } : {}) };
  writeFileSync(userConfigPath(), `${JSON.stringify(out, null, 2)}\n`);
}

// Deep-merge a partial config over a base, keeping the safe nested defaults for anything unset.
function mergeConfig(base: HeckleConfig, over: Partial<HeckleConfig>): HeckleConfig {
  return {
    ...base,
    ...over,
    drafting: { ...base.drafting, ...over.drafting },
    voice: { ...base.voice, ...over.voice },
    delivery: {
      ...base.delivery,
      ...over.delivery,
      claudeCode: { ...base.delivery.claudeCode, ...over.delivery?.claudeCode },
      cursor: { ...base.delivery.cursor, ...over.delivery?.cursor },
      codex: { ...base.delivery.codex, ...over.delivery?.codex },
    },
    memory: { ...base.memory!, ...over.memory },
    privacy: { ...base.privacy, ...over.privacy },
    ambient: {
      ...base.ambient,
      ...over.ambient,
      performance: { ...base.ambient?.performance, ...over.ambient?.performance },
    },
  };
}

/**
 * Resolve the effective config: DEFAULT_CONFIG < heckle.config.ts (if present) < the user layer
 * (`heckle config` / the gear, highest priority). Node runs the TypeScript config directly, so
 * there is no build step. Secrets come from the project `.env`, then the user layer's `env`.
 */
export async function loadConfig(cwd: string = process.cwd()): Promise<HeckleConfig> {
  // Project .env first (highest priority for secrets).
  const envPath = resolve(cwd, ".env");
  if (existsSync(envPath)) {
    try {
      process.loadEnvFile(envPath);
    } catch {
      // malformed .env, ignore and continue
    }
  }

  let merged = DEFAULT_CONFIG;
  const configPath = resolve(cwd, "heckle.config.ts");
  if (existsSync(configPath)) {
    const mod = (await import(pathToFileURL(configPath).href)) as { default?: Partial<HeckleConfig> };
    merged = mergeConfig(merged, mod.default ?? {});
  }

  // The user layer wins over heckle.config.ts. Its keys fill in only where a real env var is absent.
  const user = loadUserConfig();
  for (const [k, v] of Object.entries(user.env)) if (v && !process.env[k]) process.env[k] = v;
  merged = mergeConfig(merged, user.config);

  // localOnly is a hard gate: it forces every layer local regardless of other settings.
  if (merged.privacy.localOnly) {
    merged.drafting.provider = "ollama";
    if (!merged.drafting.baseUrl.includes("localhost") && !merged.drafting.baseUrl.includes("127.0.0.1")) {
      merged.drafting.baseUrl = "http://localhost:11434/v1";
    }
    // Only OS dictation is truly on-device. deepgram is cloud; Web Speech (Chrome)
    // streams audio to Google, neither is local, so force both to "local".
    if (merged.voice.provider !== "local") merged.voice.provider = "local";
  }

  return merged;
}

// `heckle config`: configure the drafting model, voice, and API keys from the command line,
// without editing heckle.config.ts. Writes the user layer at ~/.heckle/config.json, which the
// daemon merges on top of everything (see @heckle/daemon loadConfig).
import { DRAFTING_PRESETS, loadConfig, loadUserConfig, providerKeyEnv, saveUserConfig, userConfigPath, type UserConfig } from "@heckle/daemon";

function coerce(v: string): string | number | boolean {
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  return v;
}

function setDeep(obj: Record<string, unknown>, keys: string[], value: unknown): void {
  let node = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof node[keys[i]] !== "object" || node[keys[i]] === null) node[keys[i]] = {};
    node = node[keys[i]] as Record<string, unknown>;
  }
  node[keys[keys.length - 1]] = value;
}

function mask(v: string): string {
  return v.length <= 8 ? "****" : `${v.slice(0, 4)}…${v.slice(-2)}`;
}

function persist(mut: (u: UserConfig) => void): void {
  const u = loadUserConfig();
  mut(u);
  saveUserConfig(u);
}

async function show(): Promise<void> {
  const cfg = await loadConfig();
  const user = loadUserConfig();
  console.log("Heckle config (effective):\n");
  console.log(`  drafting   ${cfg.drafting.provider} · ${cfg.drafting.model}`);
  console.log(`  baseUrl    ${cfg.drafting.baseUrl}`);
  console.log(`  voice      ${cfg.voice.provider}`);
  console.log(`  localOnly  ${cfg.privacy.localOnly}`);
  const keys = Object.entries(user.env);
  console.log(`  keys       ${keys.length ? keys.map(([k, v]) => `${k}=${mask(v)}`).join(", ") : "(none set)"}`);
  console.log(`\n  written to ${userConfigPath()}`);
  if (cfg.privacy.localOnly && cfg.drafting.provider === "ollama") {
    console.log(`\n  Local-only mode. To use a cloud model: heckle config model deepseek <model>  (turns local-only off)`);
  }
}

export async function runConfig(args: string[]): Promise<void> {
  const [cmd, ...rest] = args;

  if (!cmd || cmd === "show") {
    await show();
    return;
  }

  if (cmd === "reset") {
    saveUserConfig({ config: {}, env: {} });
    console.log("Cleared the user config. Falling back to heckle.config.ts / local defaults.");
    return;
  }

  if (cmd === "model") {
    const [name, model, baseUrl] = rest;
    if (!name) {
      console.error(
        `heckle config model <provider> [model] [baseUrl]\n  presets: ${Object.keys(DRAFTING_PRESETS).join(" | ")}\n  or any OpenAI-compatible provider, e.g.  heckle config model groq llama-3.3-70b https://api.groq.com/openai/v1`,
      );
      process.exit(1);
    }
    const preset = DRAFTING_PRESETS[name.toLowerCase()];
    const provider = preset?.provider ?? name.toLowerCase();
    const url = baseUrl || preset?.baseUrl;
    // A custom OpenAI-compatible provider needs a base URL (it is not Ollama or Claude).
    if (!preset && provider !== "anthropic" && !url) {
      console.error(`Custom provider "${name}" needs a base URL:\n  heckle config model ${name} <model> <baseUrl>`);
      process.exit(1);
    }
    persist((u) => {
      const c = u.config as Record<string, unknown>;
      setDeep(c, ["drafting", "provider"], provider);
      if (model || preset?.defaultModel) setDeep(c, ["drafting", "model"], model || preset!.defaultModel);
      if (url) setDeep(c, ["drafting", "baseUrl"], url);
      // Anything but the local Ollama cannot run local-only (captured context leaves the machine).
      setDeep(c, ["privacy", "localOnly"], provider === "ollama");
    });
    console.log(`Drafting set to ${provider}${model || preset?.defaultModel ? ` · ${model || preset!.defaultModel}` : ""}.`);
    if (provider !== "ollama") console.log(`Local-only is now off. Set the key with:  heckle config key ${name} <api-key>`);
    return;
  }

  if (cmd === "key") {
    const [name, apiKey] = rest;
    if (!name || !apiKey) {
      console.error(`heckle config key <provider> <api-key>   e.g. heckle config key deepseek <key>  (stored as ${providerKeyEnv("deepseek")})`);
      process.exit(1);
    }
    const provider = DRAFTING_PRESETS[name.toLowerCase()]?.provider ?? name.toLowerCase();
    const keyEnv = providerKeyEnv(provider);
    persist((u) => {
      u.env[keyEnv] = apiKey;
    });
    console.log(`Saved ${keyEnv} (${mask(apiKey)}).`);
    return;
  }

  if (cmd === "voice") {
    const v = rest[0];
    if (!["local", "webspeech", "deepgram"].includes(v ?? "")) {
      console.error("heckle config voice <local | webspeech | deepgram>");
      process.exit(1);
    }
    persist((u) => setDeep(u.config as Record<string, unknown>, ["voice", "provider"], v));
    console.log(`Voice set to ${v}.`);
    return;
  }

  if (cmd === "set") {
    const [path, ...valueParts] = rest;
    const value = valueParts.join(" ");
    if (!path || value === "") {
      console.error('heckle config set <path> <value>   e.g. heckle config set drafting.model qwen3:14b');
      process.exit(1);
    }
    persist((u) => {
      if (path.startsWith("env.")) u.env[path.slice(4)] = value;
      else setDeep(u.config as Record<string, unknown>, path.split("."), coerce(value));
    });
    console.log(`set ${path} = ${path.startsWith("env.") ? mask(value) : value}`);
    return;
  }

  console.error(`heckle config [show | model | key | voice | set | reset]\n\n  heckle config model deepseek deepseek-chat\n  heckle config key deepseek <api-key>\n  heckle config voice webspeech\n  heckle config set drafting.model qwen3:14b`);
  process.exit(1);
}

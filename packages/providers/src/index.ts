// @heckle/providers, ModelProvider interface + implementations, selected by config.
import type { HeckleConfig } from "../../shared/src/index.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { OllamaProvider } from "./ollama.ts";
import { OpenAICompatibleProvider } from "./openai-compatible.ts";
import type { ModelProvider } from "./types.ts";

export type { DraftRequest, ModelProvider } from "./types.ts";
export { AnthropicProvider } from "./anthropic.ts";
export { OllamaProvider } from "./ollama.ts";
export { OpenAICompatibleProvider } from "./openai-compatible.ts";
export { buildDraftingPrompt } from "./prompt.ts";
export { extractJson, parseDraft } from "./parse.ts";

/** The env var a provider's API key is read from, e.g. deepseek -> DEEPSEEK_API_KEY. */
export function providerKeyEnv(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

/** Friendly names -> the internal provider + a default base URL / model. ANY other name is still
 *  accepted as an OpenAI-compatible endpoint (you supply the base URL). One source for CLI + gear. */
export interface DraftingPreset {
  provider: string;
  baseUrl?: string;
  defaultModel?: string;
}
export const DRAFTING_PRESETS: Record<string, DraftingPreset> = {
  ollama: { provider: "ollama", baseUrl: "http://localhost:11434/v1", defaultModel: "qwen3:14b" },
  deepseek: { provider: "deepseek", baseUrl: "https://api.deepseek.com", defaultModel: "deepseek-chat" },
  anthropic: { provider: "anthropic", defaultModel: "claude-sonnet-4-5" },
  claude: { provider: "anthropic", defaultModel: "claude-sonnet-4-5" },
};

/**
 * Select the active drafting provider from config. Keys come from the daemon's env only.
 * "ollama" and "anthropic" are handled specially; ANY other provider name is treated as an
 * OpenAI-compatible endpoint (deepseek, openai, openrouter, groq, together, mistral, a local
 * LM Studio / vLLM / llama.cpp server, ...) reached at `drafting.baseUrl`, with its key read from
 * `<PROVIDER>_API_KEY` (optional, for keyless local servers). So new models are config, not code.
 */
export function createProvider(config: HeckleConfig, env: NodeJS.ProcessEnv = process.env): ModelProvider {
  const { provider, model, baseUrl } = config.drafting;

  switch (provider) {
    case "ollama":
      // Local, no key. Native /api/chat with thinking disabled, the fast path.
      return new OllamaProvider({ baseUrl, model });

    case "anthropic": {
      const apiKey = env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error("drafting.provider=anthropic requires ANTHROPIC_API_KEY");
      return new AnthropicProvider({ model, apiKey });
    }

    default:
      // Any OpenAI-compatible endpoint. baseUrl is required; the key is optional (local servers
      // often need none). A cloud endpoint without its key will surface a clear error on first draft.
      return new OpenAICompatibleProvider({ name: provider, baseUrl, model, apiKey: env[providerKeyEnv(provider)] });
  }
}

// The drafting provider is extensible: ollama + anthropic are special-cased, and ANY other name
// is an OpenAI-compatible endpoint (deepseek, openai, openrouter, groq, together, local, ...), so
// adding a new model is config, not code.
import type { HeckleConfig } from "@heckle/shared";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AnthropicProvider, createProvider, OllamaProvider, OpenAICompatibleProvider, providerKeyEnv } from "../src/index.ts";

const cfg = (drafting: HeckleConfig["drafting"]): HeckleConfig =>
  ({ drafting, voice: { provider: "local" }, delivery: { order: [] }, agent: "claude-code", privacy: { localOnly: false } }) as HeckleConfig;

test("createProvider: ollama + anthropic special-cased; any other name is OpenAI-compatible", () => {
  assert.ok(createProvider(cfg({ provider: "ollama", model: "qwen3:14b", baseUrl: "http://localhost:11434/v1" })) instanceof OllamaProvider);

  assert.ok(createProvider(cfg({ provider: "anthropic", model: "claude-sonnet-4-5", baseUrl: "" }), { ANTHROPIC_API_KEY: "k" }) instanceof AnthropicProvider);

  // An arbitrary provider -> OpenAI-compatible, key from <PROVIDER>_API_KEY, baseUrl honoured.
  const groq = createProvider(cfg({ provider: "groq", model: "llama-3.3-70b", baseUrl: "https://api.groq.com/openai/v1" }), { GROQ_API_KEY: "gk" });
  assert.ok(groq instanceof OpenAICompatibleProvider);
  assert.equal(groq.name, "groq");

  // A keyless local OpenAI-compatible server also works (no key required to construct).
  assert.ok(createProvider(cfg({ provider: "lmstudio", model: "whatever", baseUrl: "http://localhost:1234/v1" }), {}) instanceof OpenAICompatibleProvider);
});

test("providerKeyEnv derives <PROVIDER>_API_KEY", () => {
  assert.equal(providerKeyEnv("deepseek"), "DEEPSEEK_API_KEY");
  assert.equal(providerKeyEnv("open-router"), "OPEN_ROUTER_API_KEY");
});

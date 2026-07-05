// Claude provider for production-quality drafting. Raw fetch against the Messages API
// (no SDK) to keep the daemon dependency-free and consistent with the OpenAI-compatible
// provider. On claude-opus-4-8 / claude-sonnet-5: sampling params (temperature/top_p/top_k)
// are rejected and assistant prefill is gone, so JSON is forced via the system prompt +
// robust parsing rather than a prefill. All calls server-side; the key never reaches the browser.
import type { DraftInput } from "@heckle/shared/feedback";
import { parseDraft } from "./parse.ts";
import { buildDraftingPrompt } from "./prompt.ts";
import type { DraftRequest, ModelProvider } from "./types.ts";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export class AnthropicProvider implements ModelProvider {
  readonly name = "anthropic";
  private readonly model: string;
  private readonly apiKey: string;

  constructor(opts: { model: string; apiKey: string }) {
    this.model = opts.model;
    this.apiKey = opts.apiKey;
  }

  async draft(req: DraftRequest): Promise<DraftInput> {
    const { system, user } = buildDraftingPrompt(req);
    let raw = await this.complete(system, user);
    let parsed = parseDraft(raw);
    if (!parsed.ok) {
      raw = await this.complete(system, `${user}\n\nReply with ONLY the JSON object, no prose.`);
      parsed = parseDraft(raw);
    }
    if (!parsed.ok) throw new Error(`anthropic drafting failed: ${parsed.error}`);
    return parsed.value;
  }

  private async complete(system: string, user: string): Promise<string> {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model, // e.g. claude-sonnet-5 (latest Sonnet) or claude-opus-4-8
        max_tokens: 2048,
        system,
        messages: [{ role: "user", content: user }],
        // No temperature/top_p/top_k: removed on current Claude models (would 400).
      }),
    });
    if (!res.ok) {
      throw new Error(`anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      stop_reason?: string;
      content?: Array<{ type: string; text?: string }>;
    };
    if (json.stop_reason === "refusal") throw new Error("anthropic refused the drafting request");
    return (json.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
  }
}

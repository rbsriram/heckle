// Local Ollama provider, the fast, private dev-loop default. Uses Ollama's NATIVE
// /api/chat (not the OpenAI-compatible /v1 shim) so it can pass `think: false`, which
// disables qwen3's reasoning mode. That single flag takes drafting from ~58s to ~2s on
// qwen3:14b, and latency is the make-or-break for this product. `format: "json"`
// constrains the output to valid JSON.
import type { DraftInput } from "@heckle/shared/feedback";
import { parseDraft } from "./parse.ts";
import { buildDraftingPrompt } from "./prompt.ts";
import type { DraftRequest, ModelProvider } from "./types.ts";

export class OllamaProvider implements ModelProvider {
  readonly name = "ollama";
  private readonly url: string;
  private readonly model: string;

  constructor(opts: { baseUrl: string; model: string }) {
    // config gives the OpenAI-compatible base (…/v1); the native chat API is …/api/chat.
    const host = opts.baseUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "");
    this.url = `${host}/api/chat`;
    this.model = opts.model;
  }

  async warmup(): Promise<void> {
    // Load the model into memory so the first real draft is fast. Best-effort.
    await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        think: false,
        stream: false,
        keep_alive: "10m",
        messages: [{ role: "user", content: "ok" }],
      }),
    });
  }

  async draft(req: DraftRequest): Promise<DraftInput> {
    const { system, user } = buildDraftingPrompt(req);
    let raw = await this.complete(system, user);
    let parsed = parseDraft(raw);
    if (!parsed.ok) {
      raw = await this.complete(system, `${user}\n\nReturn ONLY the JSON object.`);
      parsed = parseDraft(raw);
    }
    if (!parsed.ok) throw new Error(`ollama drafting failed: ${parsed.error}`);
    return parsed.value;
  }

  private async complete(system: string, user: string): Promise<string> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        think: false, // disable reasoning mode, the key latency win
        stream: false,
        format: "json", // constrain to valid JSON
        options: { temperature: 0.2 },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) {
      throw new Error(`ollama HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const json = (await res.json()) as { message?: { content?: string } };
    return json.message?.content ?? "";
  }
}

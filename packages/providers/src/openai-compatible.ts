// One class covers every OpenAI-compatible chat endpoint: local Ollama
// (http://localhost:11434/v1, no key) and DeepSeek (https://api.deepseek.com, keyed).
// All calls are server-side (daemon); keys never touch the browser.
import type { DraftInput } from "@heckle/shared/feedback";
import { parseDraft } from "./parse.ts";
import { buildDraftingPrompt } from "./prompt.ts";
import type { DraftRequest, ModelProvider } from "./types.ts";

export class OpenAICompatibleProvider implements ModelProvider {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey?: string;

  constructor(opts: { name: string; baseUrl: string; model: string; apiKey?: string }) {
    this.name = opts.name;
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.model = opts.model;
    this.apiKey = opts.apiKey;
  }

  async draft(req: DraftRequest): Promise<DraftInput> {
    const { system, user } = buildDraftingPrompt(req);
    let raw = await this.complete(system, user);
    let parsed = parseDraft(raw);
    if (!parsed.ok) {
      // one corrective retry, per the spec
      raw = await this.complete(
        system,
        `${user}\n\nYour previous reply was not valid JSON for the schema. Reply with ONLY the JSON object, no markdown, no prose, no <think>.`,
      );
      parsed = parseDraft(raw);
    }
    if (!parsed.ok) throw new Error(`${this.name} drafting failed: ${parsed.error}`);
    return parsed.value;
  }

  private async complete(system: string, user: string): Promise<string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.2,
        response_format: { type: "json_object" },
        stream: false,
      }),
    });
    if (!res.ok) {
      throw new Error(`${this.name} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return json.choices?.[0]?.message?.content ?? "";
  }
}

// Robustly pull a JSON object out of a model reply and validate it against the Feedback
// draft schema. Handles <think> blocks, markdown fences, and surrounding prose.
import { DraftSchema, type DraftInput } from "../../shared/src/feedback.ts";

export function extractJson(raw: string): string {
  let s = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) s = s.slice(start, end + 1);
  return s;
}

export type ParseResult = { ok: true; value: DraftInput } | { ok: false; error: string };

export function parseDraft(raw: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch (e) {
    return { ok: false, error: `not JSON: ${(e as Error).message}` };
  }
  const result = DraftSchema.safeParse(parsed);
  if (!result.success) return { ok: false, error: result.error.message };
  return { ok: true, value: result.data };
}

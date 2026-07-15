// The Feedback contract. This zod schema is the runtime source of truth, drafting
// validates against it, delivery and memory consume it.
//
// NOTE: this file imports zod (a third-party runtime dependency). It is intentionally
// NOT re-exported from ./index.ts during M0 so the scaffold runs with zero installed
// deps. It is wired in at M2 (Drafting), where zod gets installed and validation runs.
import { z } from "zod";

export const SeveritySchema = z.enum(["blocker", "bug", "polish"]);

const ReproTargetSchema = z.object({
  testid: z.string().optional(),
  role: z.string().optional(),
  name: z.string().optional(),
  css: z.string().optional(),
});

export const ReproAssertionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text_equals"), target: ReproTargetSchema, expected: z.string() }),
  z.object({ type: z.literal("console_clean"), levels: z.array(z.enum(["log", "info", "warn", "error", "debug"])) }),
  z.object({ type: z.literal("no_failed_requests"), exclude: z.array(z.string()) }),
]);

export const HistorySchema = z
  .object({
    kind: z.enum(["flagged-before", "still-open", "recurring"]),
    note: z.string(),
    issueId: z.string(),
  })
  .nullable();

// A real, actionable draft (without id/history, which the daemon fills in).
export const RealDraftSchema = z.object({
  intent: z.string().min(1),
  target: z.object({
    selector: z.string().optional(),
    flow: z.string().optional(),
  }),
  severity: SeveritySchema,
  repro: z.array(z.string()),
  context: z.object({
    consoleRefs: z.array(z.string()),
    networkRefs: z.array(z.string()),
    domSnapshotId: z.string().optional(),
  }),
  fixHint: z.string().optional(),
  assertions: z.array(ReproAssertionSchema).optional(),
});

// The model may decline: nothing actionable to report (empty/vague input, or app works).
export const NoIssueSchema = z.object({
  noIssue: z.literal(true),
  reason: z.string().optional(),
});

// What the model is allowed to return: a real draft, or an explicit decline.
export const DraftSchema = z.union([NoIssueSchema, RealDraftSchema]);

// The full object after the daemon attaches id + memory annotation.
export const FeedbackSchema = RealDraftSchema.extend({
  id: z.string(),
  history: HistorySchema.optional(),
});

export type RealDraft = z.infer<typeof RealDraftSchema>;
export type NoIssue = z.infer<typeof NoIssueSchema>;
export type DraftInput = z.infer<typeof DraftSchema>;
export type FeedbackParsed = z.infer<typeof FeedbackSchema>;

/** True when the model declined to draft (nothing actionable to report). */
export function isNoIssue(d: DraftInput): d is NoIssue {
  return "noIssue" in d && d.noIssue === true;
}

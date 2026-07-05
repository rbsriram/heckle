// The drafting provider interface. One narrow job: turn loose speech + captured runtime
// context into a single structured, agent-ready Feedback draft. Swappable by config.
import type { ContextBundle, Issue } from "@heckle/shared";
import type { DraftInput } from "@heckle/shared/feedback";

export interface DraftRequest {
  transcript: string; // what the user said or typed
  context: ContextBundle; // captured DOM/console/network slice
  related: Issue[]; // prior related issues from memory (empty until M5)
  // The user is overriding a prior "nothing to flag": draft anyway, do not decline.
  insist?: boolean;
}

export interface ModelProvider {
  readonly name: string;
  /** Produce a schema-valid Feedback draft (no id/history, the orchestrator adds those). */
  draft(req: DraftRequest): Promise<DraftInput>;
  /** Optional: pre-load/warm the model so the first real draft isn't slow (local models). */
  warmup?(): Promise<void>;
}

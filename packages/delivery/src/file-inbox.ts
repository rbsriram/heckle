// The floor. Appends approved feedback to .heckle/inbox.md, every agent reads files, so
// this never fails to transport. Always written, regardless of which adapter "fires".
import type { ContextBundle, DeliveryResult, Feedback } from "../../shared/src/index.ts";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatFeedbackMarkdown } from "./format.ts";
import { receiptRelPath } from "./receipt.ts";
import type { DeliveryAdapter } from "./types.ts";

// Strip the item with this feedback id from .heckle/inbox.md (best-effort). Items are written as
// `---`-delimited blocks, each ending in `<sub>heckle <id> ...</sub>`, so we drop the block that
// carries this id. Used when a user removes a row so the agent won't later act on it.
export function removeInboxItem(projectRoot: string, feedbackId: string): void {
  try {
    const inboxPath = resolve(projectRoot, ".heckle", "inbox.md");
    if (!existsSync(inboxPath)) return;
    const text = readFileSync(inboxPath, "utf8");
    const kept = text.split(/\n---\n/).filter((block) => !block.includes(`heckle ${feedbackId}`));
    writeFileSync(inboxPath, kept.join("\n---\n"));
  } catch {
    // best-effort: the widget row is still removed even if the file rewrite fails
  }
}

export class FileInboxAdapter implements DeliveryAdapter {
  readonly name = "file-inbox" as const;
  private readonly dir: string;
  private readonly inboxPath: string;

  constructor(projectRoot: string) {
    this.dir = resolve(projectRoot, ".heckle");
    this.inboxPath = resolve(this.dir, "inbox.md");
  }

  get path(): string {
    return this.inboxPath;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async deliver(feedback: Feedback, context: ContextBundle): Promise<DeliveryResult> {
    try {
      mkdirSync(this.dir, { recursive: true });
      // Reference the task context receipt the daemon writes at approval (a project-relative
      // convention, so the reference is deterministic even though the daemon owns the write).
      const md = formatFeedbackMarkdown(feedback, context, { ts: Date.now(), receiptPath: receiptRelPath(feedback.id) });
      appendFileSync(this.inboxPath, `\n---\n\n${md}\n`);
      return { adapter: this.name, ok: true, detail: this.inboxPath };
    } catch (err) {
      return { adapter: this.name, ok: false, detail: (err as Error).message };
    }
  }
}

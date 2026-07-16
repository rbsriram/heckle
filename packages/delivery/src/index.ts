// @heckle/delivery, the adapter chain. The file inbox is always written as the durable
// record; the configured order picks the richest available "trigger", falling down on failure.
import type { ContextBundle, DeliveryAdapterName, DeliveryResult, Feedback, HeckleConfig } from "../../shared/src/index.ts";
import { ClaudeCodeDispatchAdapter } from "./claude-code.ts";
import { ClipboardAdapter } from "./clipboard.ts";
import { CodexDispatchAdapter } from "./codex.ts";
import { CursorDispatchAdapter } from "./cursor.ts";
import { FileInboxAdapter } from "./file-inbox.ts";
import type { DeliveryAdapter, SpawnFn, WhichFn } from "./types.ts";

export type { DeliveryAdapter, SpawnFn, WhichFn } from "./types.ts";
export { formatFeedbackMarkdown } from "./format.ts";
export {
  buildTaskContextReceipt,
  receiptRelPath,
  removeTaskContextReceipt,
  writeTaskContextReceipt,
  RECEIPT_SCHEMA,
  type ReceiptDispatchInfo,
  type ReceiptInput,
  type TaskContextReceipt,
} from "./receipt.ts";
export { FileInboxAdapter, appendVerificationFailure, removeInboxItem } from "./file-inbox.ts";
export { ClipboardAdapter } from "./clipboard.ts";
export { ClaudeCodeDispatchAdapter } from "./claude-code.ts";
export { CursorDispatchAdapter } from "./cursor.ts";
export { CodexDispatchAdapter } from "./codex.ts";
export {
  installAgentContext,
  hasAgentContext,
  hasAnyAgentContext,
  HECKLE_SKILL,
  type AgentKind,
  type InstallResult,
} from "./agent-context.ts";

// The adapters that actually run a coding agent (as opposed to the file-inbox / clipboard floor).
// Single source of truth for "was a fix really dispatched?" checks and agent-vs-fallback routing.
export type DispatchAdapterName = "claude-code" | "cursor" | "codex";
export const DISPATCH_ADAPTERS: readonly DispatchAdapterName[] = ["claude-code", "cursor", "codex"];
export function isDispatchAdapter(name: string): name is DispatchAdapterName {
  return (DISPATCH_ADAPTERS as readonly string[]).includes(name);
}

export interface DeliveryDeps {
  projectRoot?: string;
  permissionMode?: string;
  spawnFn?: SpawnFn;
  whichFn?: WhichFn;
  // Fires when a dispatched fix process exits; ok = the fix LANDED (working tree changed).
  onDispatchComplete?: (ok: boolean, feedbackId: string) => void;
  // Fires with a one-line status while a dispatched fix runs (e.g. "Editing Hero.tsx").
  onDispatchProgress?: (feedbackId: string, line: string) => void;
}

export class DeliveryChain {
  private readonly order: DeliveryAdapterName[];
  private readonly fileInbox: FileInboxAdapter;
  private readonly adapters: Map<DeliveryAdapterName, DeliveryAdapter>;

  constructor(config: HeckleConfig, deps: DeliveryDeps = {}) {
    const projectRoot = deps.projectRoot ?? process.cwd();
    this.order = config.delivery.order;
    this.fileInbox = new FileInboxAdapter(projectRoot);
    const cc = config.delivery.claudeCode ?? {};
    const cur = config.delivery.cursor ?? {};
    const cod = config.delivery.codex ?? {};
    this.adapters = new Map<DeliveryAdapterName, DeliveryAdapter>([
      ["file-inbox", this.fileInbox],
      ["clipboard", new ClipboardAdapter({ spawnFn: deps.spawnFn })],
      [
        "claude-code",
        new ClaudeCodeDispatchAdapter({
          projectRoot,
          // An explicit dep override wins; otherwise take the posture from config.
          permissionMode: deps.permissionMode ?? cc.permissionMode,
          session: cc.session,
          allowedTools: cc.allowedTools,
          spawnFn: deps.spawnFn,
          whichFn: deps.whichFn,
          onComplete: deps.onDispatchComplete,
          onProgress: deps.onDispatchProgress,
        }),
      ],
      [
        "cursor",
        new CursorDispatchAdapter({
          projectRoot,
          session: cur.session,
          force: cur.force,
          model: cur.model,
          spawnFn: deps.spawnFn,
          whichFn: deps.whichFn,
          onComplete: deps.onDispatchComplete,
          onProgress: deps.onDispatchProgress,
        }),
      ],
      [
        "codex",
        new CodexDispatchAdapter({
          projectRoot,
          session: cod.session,
          sandbox: cod.sandbox,
          askForApproval: cod.askForApproval,
          skipGitRepoCheck: cod.skipGitRepoCheck,
          model: cod.model,
          spawnFn: deps.spawnFn,
          whichFn: deps.whichFn,
          onComplete: deps.onDispatchComplete,
          onProgress: deps.onDispatchProgress,
        }),
      ],
    ]);
  }

  get inboxPath(): string {
    return this.fileInbox.path;
  }

  /** Always write the inbox, then deliver via the highest available adapter in config order. */
  async deliver(feedback: Feedback, context: ContextBundle): Promise<DeliveryResult[]> {
    const results: DeliveryResult[] = [];

    const inbox = await this.fileInbox.deliver(feedback, context); // durable record, always
    results.push(inbox);

    for (const name of this.order) {
      if (name === "file-inbox") {
        if (inbox.ok) break; // the floor already succeeded
        continue;
      }
      const adapter = this.adapters.get(name);
      if (!adapter) continue;
      if (!(await adapter.isAvailable())) {
        results.push({ adapter: name, ok: false, detail: "unavailable" });
        continue;
      }
      const r = await adapter.deliver(feedback, context);
      results.push(r);
      if (r.ok) break; // delivered via the richest available adapter
    }
    return results;
  }
}

export function createDeliveryChain(config: HeckleConfig, deps?: DeliveryDeps): DeliveryChain {
  return new DeliveryChain(config, deps);
}

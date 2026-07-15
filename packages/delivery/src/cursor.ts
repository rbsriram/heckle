// Dispatch an approved fix to Cursor's headless agent CLI (`cursor-agent`). Headless is
// `-p --force` (plain `-p` only PROPOSES edits; --force lets them land). Cursor has no
// supply-your-own-id, so for an accumulating session we mint one with `create-chat`, persist
// it, and `--resume` it thereafter. Facts verified against cursor.com/docs/cli (July 2026).
import type { ContextBundle, DeliveryResult, Feedback } from "../../shared/src/index.ts";
import { buildFixPrompt, defaultSpawn, defaultWhich, readSessionId, runDetachedFix, writeSessionId } from "./agent-dispatch.ts";
import type { DeliveryAdapter, SpawnFn, WhichFn } from "./types.ts";

const SESSION_FILE = "cursor-session-id";
const MINT_TIMEOUT_MS = 15_000; // create-chat guard: older beta CLIs could hang headless

export class CursorDispatchAdapter implements DeliveryAdapter {
  readonly name = "cursor" as const;
  private readonly projectRoot: string;
  private readonly session: string;
  private readonly force: boolean;
  private readonly model?: string;
  private readonly spawnFn: SpawnFn;
  private readonly whichFn: WhichFn;
  private readonly onComplete?: (ok: boolean, feedbackId: string) => void;
  private readonly onProgress?: (feedbackId: string, line: string) => void;

  constructor(opts: {
    projectRoot: string;
    session?: string;
    force?: boolean;
    model?: string;
    spawnFn?: SpawnFn;
    whichFn?: WhichFn;
    onComplete?: (ok: boolean, feedbackId: string) => void;
    onProgress?: (feedbackId: string, line: string) => void;
  }) {
    this.projectRoot = opts.projectRoot;
    this.session = opts.session ?? "persistent";
    // Real edits require --force; the human approval is the gate, so default it on.
    this.force = opts.force ?? true;
    this.model = opts.model;
    this.spawnFn = opts.spawnFn ?? defaultSpawn;
    this.whichFn = opts.whichFn ?? defaultWhich;
    this.onComplete = opts.onComplete;
    this.onProgress = opts.onProgress;
  }

  async isAvailable(): Promise<boolean> {
    return this.whichFn("cursor-agent");
  }

  buildPrompt(feedback: Feedback, context: ContextBundle): string {
    return buildFixPrompt(feedback, context);
  }

  /**
   * "fresh" -> no --resume. A pinned chat id -> resume it. "persistent" (default) -> reuse the
   * chat id kept in .heckle/cursor-session-id, minting one via `cursor-agent create-chat` the
   * first time. Async so minting never blocks the daemon; falls back to fresh if it fails.
   */
  async resolveSessionId(): Promise<string | undefined> {
    if (this.session === "fresh") return undefined;
    if (this.session !== "persistent") return this.session; // a pinned chat id
    const existing = readSessionId(this.projectRoot, SESSION_FILE);
    if (existing) return existing;
    const minted = await this.mintChat();
    if (minted) writeSessionId(this.projectRoot, SESSION_FILE, minted);
    return minted;
  }

  // `cursor-agent create-chat` prints a new chat id; take the last token to be robust to labels.
  // Goes through this.spawnFn (not node's spawn) so a test's injected stub never launches a
  // real process. The await in deliver() is bounded by MINT_TIMEOUT_MS and pays only once
  // per project (the minted id is persisted).
  private mintChat(): Promise<string | undefined> {
    return new Promise((res) => {
      let out = "";
      let done = false;
      const finish = (v: string | undefined) => {
        if (done) return;
        done = true;
        res(v);
      };
      try {
        const child = this.spawnFn("cursor-agent", ["create-chat"], { cwd: this.projectRoot });
        const timer = setTimeout(() => {
          child.kill?.();
          finish(undefined);
        }, MINT_TIMEOUT_MS);
        child.stdout?.on("data", (d) => (out += String(d)));
        child.on?.("error", () => {
          clearTimeout(timer);
          finish(undefined);
        });
        child.on?.("exit", (code) => {
          clearTimeout(timer);
          finish(code === 0 ? out.trim().split(/\s+/).pop() || undefined : undefined);
        });
      } catch {
        finish(undefined);
      }
    });
  }

  buildArgs(prompt: string, sessionId?: string): string[] {
    const args = ["-p"];
    if (this.force) args.push("--force");
    args.push("--workspace", this.projectRoot);
    if (this.model) args.push("--model", this.model);
    if (sessionId) args.push("--resume", sessionId);
    // The prompt is a positional; keep it last.
    args.push(prompt);
    return args;
  }

  async deliver(feedback: Feedback, context: ContextBundle): Promise<DeliveryResult> {
    const args = this.buildArgs(this.buildPrompt(feedback, context), await this.resolveSessionId());
    return runDetachedFix({
      name: this.name,
      binary: "cursor-agent",
      args,
      projectRoot: this.projectRoot,
      feedbackId: feedback.id,
      spawnFn: this.spawnFn,
      onComplete: this.onComplete,
      onProgress: this.onProgress,
    });
  }
}

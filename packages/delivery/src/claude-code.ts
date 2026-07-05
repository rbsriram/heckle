// The strongest path: hand the approved feedback to Claude Code as a headless task, so
// approve-to-fix kicks off automatically. Both transport and trigger. Dispatching after
// approval does not violate the human-approved principle, the approval click is the gate.
import type { ContextBundle, DeliveryResult, Feedback } from "@heckle/shared";
import { randomUUID } from "node:crypto";
import { buildFixPrompt, defaultSpawn, defaultWhich, parseClaudeStreamLine, readSessionId, runDetachedFix, writeSessionId } from "./agent-dispatch.ts";
import type { DeliveryAdapter, SpawnFn, WhichFn } from "./types.ts";

const SESSION_FILE = "claude-session-id";

export class ClaudeCodeDispatchAdapter implements DeliveryAdapter {
  readonly name = "claude-code" as const;
  private readonly projectRoot: string;
  private readonly permissionMode: string;
  private readonly session: string;
  private readonly allowedTools: string[];
  private readonly spawnFn: SpawnFn;
  private readonly whichFn: WhichFn;
  private readonly onComplete?: (ok: boolean, feedbackId: string) => void;
  private readonly onProgress?: (feedbackId: string, line: string) => void;

  constructor(opts: {
    projectRoot: string;
    permissionMode?: string;
    session?: string;
    allowedTools?: string[];
    spawnFn?: SpawnFn;
    whichFn?: WhichFn;
    onComplete?: (ok: boolean, feedbackId: string) => void;
    onProgress?: (feedbackId: string, line: string) => void;
  }) {
    this.projectRoot = opts.projectRoot;
    // acceptEdits lets the approved fix land without a second prompt; the approval was the gate.
    this.permissionMode = opts.permissionMode ?? "acceptEdits";
    // Persistent by default: fixes share one owned conversation so context accumulates.
    this.session = opts.session ?? "persistent";
    this.allowedTools = opts.allowedTools ?? [];
    this.spawnFn = opts.spawnFn ?? defaultSpawn;
    this.whichFn = opts.whichFn ?? defaultWhich;
    this.onComplete = opts.onComplete;
    this.onProgress = opts.onProgress;
  }

  async isAvailable(): Promise<boolean> {
    return this.whichFn("claude");
  }

  buildPrompt(feedback: Feedback, context: ContextBundle): string {
    return buildFixPrompt(feedback, context);
  }

  /**
   * Resolve the session to use with `claude -p`. Claude accepts `--session-id` only to CREATE a
   * session; continuing an existing one MUST use `--resume` (reusing --session-id errors "Session
   * ID already in use"). So we report whether this is a new session or a continuation.
   * "fresh" -> none. A pinned id -> resume it. "persistent" (default) -> one id owned by this
   * project, kept in .heckle/claude-session-id: created on the first dispatch, resumed after.
   * A minted id is NOT persisted here; deliver() writes it only once the creating dispatch
   * exits clean, otherwise a failed first dispatch would poison every later --resume.
   */
  resolveSession(): { id: string; resume: boolean } | undefined {
    if (this.session === "fresh") return undefined;
    if (this.session !== "persistent") return { id: this.session, resume: true }; // pinned -> continue
    const existing = readSessionId(this.projectRoot, SESSION_FILE);
    if (existing) return { id: existing, resume: true }; // created on a prior dispatch -> resume
    return { id: randomUUID(), resume: false }; // first dispatch in this project -> create it
  }

  buildArgs(prompt: string, session?: { id: string; resume: boolean }): string[] {
    const args = ["-p", prompt, "--permission-mode", this.permissionMode];
    // stream-json (requires --verbose in print mode) emits one JSON event per step, which we
    // parse into a live one-line status while the fix runs.
    args.push("--output-format", "stream-json", "--verbose");
    if (session) args.push(session.resume ? "--resume" : "--session-id", session.id);
    // Keep --allowedTools last: it is variadic, so nothing must follow it.
    if (this.allowedTools.length) args.push("--allowedTools", ...this.allowedTools);
    return args;
  }

  async deliver(feedback: Feedback, context: ContextBundle): Promise<DeliveryResult> {
    const session = this.resolveSession();
    const args = this.buildArgs(this.buildPrompt(feedback, context), session);
    return runDetachedFix({
      name: this.name,
      binary: "claude",
      args,
      projectRoot: this.projectRoot,
      feedbackId: feedback.id,
      spawnFn: this.spawnFn,
      // The minted id becomes the project's persistent session only after the creating
      // dispatch succeeds; a failed create leaves the file absent so the next fix re-creates.
      onExit:
        session && !session.resume
          ? (code) => {
              if (code === 0) writeSessionId(this.projectRoot, SESSION_FILE, session.id);
            }
          : undefined,
      onComplete: this.onComplete,
      onProgress: this.onProgress,
      parseLine: parseClaudeStreamLine,
    });
  }
}

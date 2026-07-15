// Dispatch an approved fix to the OpenAI Codex CLI headlessly (`codex exec`). For unattended
// edits + test runs the posture is `--sandbox workspace-write --ask-for-approval never` (any
// approval prompt under a non-"never" policy fails a non-interactive run). Codex has NO
// supply-your-own-id, and its ids must be scraped from `--json` output, so for an accumulating
// session we use `exec resume` rather than minting an id. Facts verified against
// developers.openai.com/codex (July 2026).
import type { ContextBundle, DeliveryResult, Feedback } from "../../shared/src/index.ts";
import { buildFixPrompt, defaultSpawn, defaultWhich, runDetachedFix } from "./agent-dispatch.ts";
import type { DeliveryAdapter, SpawnFn, WhichFn } from "./types.ts";

export class CodexDispatchAdapter implements DeliveryAdapter {
  readonly name = "codex" as const;
  private readonly projectRoot: string;
  // "fresh" (default) - new session per fix; "continue" - resume the newest session in this dir
  // (accumulates, but can collide with your own codex sessions here); or a pinned session id.
  private readonly session: string;
  private readonly sandbox: string;
  private readonly askForApproval: string;
  private readonly skipGitRepoCheck: boolean;
  private readonly model?: string;
  private readonly spawnFn: SpawnFn;
  private readonly whichFn: WhichFn;
  private readonly onComplete?: (ok: boolean, feedbackId: string) => void;
  private readonly onProgress?: (feedbackId: string, line: string) => void;

  constructor(opts: {
    projectRoot: string;
    session?: string;
    sandbox?: string;
    askForApproval?: string;
    skipGitRepoCheck?: boolean;
    model?: string;
    spawnFn?: SpawnFn;
    whichFn?: WhichFn;
    onComplete?: (ok: boolean, feedbackId: string) => void;
    onProgress?: (feedbackId: string, line: string) => void;
  }) {
    this.projectRoot = opts.projectRoot;
    this.session = opts.session ?? "fresh";
    this.sandbox = opts.sandbox ?? "workspace-write";
    this.askForApproval = opts.askForApproval ?? "never";
    this.skipGitRepoCheck = opts.skipGitRepoCheck ?? true;
    this.model = opts.model;
    this.spawnFn = opts.spawnFn ?? defaultSpawn;
    this.whichFn = opts.whichFn ?? defaultWhich;
    this.onComplete = opts.onComplete;
    this.onProgress = opts.onProgress;
  }

  async isAvailable(): Promise<boolean> {
    return this.whichFn("codex");
  }

  buildPrompt(feedback: Feedback, context: ContextBundle): string {
    return buildFixPrompt(feedback, context);
  }

  buildArgs(prompt: string): string[] {
    const args = ["exec"];
    // Session selection is expressed in the subcommand, not a flag Codex accepts an id for.
    if (this.session === "continue") args.push("resume", "--last");
    else if (this.session !== "fresh") args.push("resume", this.session); // a pinned session id
    args.push("--cd", this.projectRoot, "--sandbox", this.sandbox, "--ask-for-approval", this.askForApproval);
    if (this.skipGitRepoCheck) args.push("--skip-git-repo-check");
    if (this.model) args.push("--model", this.model);
    // The prompt is the trailing positional.
    args.push(prompt);
    return args;
  }

  async deliver(feedback: Feedback, context: ContextBundle): Promise<DeliveryResult> {
    const args = this.buildArgs(this.buildPrompt(feedback, context));
    return runDetachedFix({
      name: this.name,
      binary: "codex",
      args,
      projectRoot: this.projectRoot,
      feedbackId: feedback.id,
      spawnFn: this.spawnFn,
      onComplete: this.onComplete,
      onProgress: this.onProgress,
    });
  }
}

// Shared machinery for the headless-agent dispatch adapters (Claude Code, Cursor, Codex).
// Each agent's fix runs the same way: one owned, accumulating session per project so a fix
// sees the earlier fixes, spawned detached, logged to .heckle/dispatch-<id>.log. Only the
// binary, the arg shape, and how a session id is obtained differ per agent.
import type { ContextBundle, DeliveryAdapterName, DeliveryResult, Feedback } from "@heckle/shared";
import { execFileSync, spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { formatFeedbackMarkdown } from "./format.ts";
import type { SpawnedChild, SpawnFn, WhichFn } from "./types.ts";

export const defaultSpawn: SpawnFn = (cmd, args, opts) => nodeSpawn(cmd, [...args], opts);

export const defaultWhich: WhichFn = async (cmd) => {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, cmd), constants.X_OK);
      return true;
    } catch {
      // not here
    }
  }
  return false;
};

// The instruction handed to the agent. Identical across Claude/Cursor/Codex; the note about an
// "ongoing session" is what makes an accumulating session read the prior fixes as context.
export function buildFixPrompt(feedback: Feedback, context: ContextBundle): string {
  return [
    `A Heckle QA item was just approved by the user. Address it now.`,
    `This is an ongoing Heckle QA session, so you may have already fixed earlier items here.`,
    `Read .heckle/inbox.md and fix the open item with id ${feedback.id}, then note it done in that file.`,
    ``,
    `The item:`,
    formatFeedbackMarkdown(feedback, context),
  ].join("\n");
}

// Read/write a per-agent session token kept in .heckle/<file>. Best-effort: on any FS error we
// return undefined (the caller falls back to a fresh session rather than failing the fix).
export function readSessionId(projectRoot: string, file: string): string | undefined {
  try {
    const p = resolve(projectRoot, ".heckle", file);
    if (existsSync(p)) {
      const id = readFileSync(p, "utf8").trim();
      if (id) return id;
    }
  } catch {
    // unreadable -> treat as no session
  }
  return undefined;
}

export function writeSessionId(projectRoot: string, file: string, id: string): void {
  try {
    const dir = resolve(projectRoot, ".heckle");
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, file), id);
  } catch {
    // cannot persist -> the next dispatch simply starts a fresh session
  }
}

// A cheap fingerprint of the project's uncommitted state: `git status` (catches new/removed
// files) plus `git diff HEAD` (catches content edits to tracked files, even ones already dirty).
// Returns undefined when this is not a git repo (or git is missing), so the caller can fall back.
function workingTreeSignature(root: string): string | undefined {
  try {
    const run = (args: string[]) =>
      execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
    return createHash("sha1").update(run(["status", "--porcelain"])).update(run(["diff", "HEAD"])).digest("hex");
  } catch {
    return undefined;
  }
}

/**
 * Spawn a headless fix, teeing output to .heckle/dispatch-<id>.log and streaming a one-line
 * progress signal (via parseLine -> onProgress) while it runs. The daemon observes the exit to
 * fire onComplete, whose `ok` means "the fix LANDED" (the working tree actually changed), NOT
 * merely "the process exited 0": an agent can edit files correctly and still exit non-zero when
 * its own self-verification (a blocked command, a failing test) fails. We fall back to the exit
 * code only when the project is not a git repo. onExit runs first (raw exit code + log path) so
 * an adapter can post-process (e.g. persist a session id only on a clean create).
 */
export function runDetachedFix(o: {
  name: DeliveryAdapterName;
  binary: string;
  args: string[];
  projectRoot: string;
  feedbackId: string;
  spawnFn: SpawnFn;
  onComplete?: (ok: boolean, feedbackId: string) => void;
  onExit?: (code: number | null, logPath: string) => void;
  onProgress?: (feedbackId: string, line: string) => void;
  // Turn one raw stdout line into a short human status ("Editing Hero.tsx"), or undefined to skip.
  parseLine?: (line: string) => string | undefined;
}): DeliveryResult {
  try {
    const heckleDir = resolve(o.projectRoot, ".heckle");
    mkdirSync(heckleDir, { recursive: true });
    const logPath = resolve(heckleDir, `dispatch-${o.feedbackId}.log`);
    const before = workingTreeSignature(o.projectRoot);
    const child = o.spawnFn(o.binary, o.args, { cwd: o.projectRoot, stdio: ["ignore", "pipe", "pipe"] });

    // Tee stdout+stderr to the log file, and feed complete stdout lines to the progress parser.
    const logStream = child.stdout || child.stderr ? createWriteStream(logPath, { flags: "a" }) : null;
    let buf = "";
    child.stdout?.on("data", (d: unknown) => {
      const s = String(d);
      logStream?.write(s);
      if (!o.parseLine || !o.onProgress) return;
      buf += s;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const msg = line.trim() ? o.parseLine(line) : undefined;
        if (msg) o.onProgress(o.feedbackId, msg);
      }
    });
    child.stderr?.on("data", (d: unknown) => logStream?.write(String(d)));

    child.on?.("exit", (code: unknown) => {
      const c = typeof code === "number" ? code : null;
      logStream?.end();
      o.onExit?.(c, logPath);
      const after = workingTreeSignature(o.projectRoot);
      // Landed = the working tree changed. Only fall back to the exit code when git can't tell us.
      const landed = before !== undefined && after !== undefined ? after !== before : c === 0;
      o.onComplete?.(landed, o.feedbackId);
    });
    child.on?.("error", () => {
      logStream?.end();
      o.onComplete?.(false, o.feedbackId);
    });
    return { adapter: o.name, ok: true, detail: `dispatched (log ${logPath})` };
  } catch (err) {
    return { adapter: o.name, ok: false, detail: (err as Error).message };
  }
}

// Parse one line of `claude -p --output-format stream-json` into a short activity status, or
// undefined for events with nothing worth showing. Each line is a JSON event; the useful ones
// are `assistant` messages whose content includes a tool_use (that IS the agent's current action).
export function parseClaudeStreamLine(line: string): string | undefined {
  let ev: { type?: string; message?: { content?: Array<Record<string, unknown>> }; subtype?: string };
  try {
    ev = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (ev.type === "result") return "Wrapping up";
  if (ev.type !== "assistant") return undefined;
  const blocks = ev.message?.content ?? [];
  const tool = blocks.find((b) => b.type === "tool_use") as { name?: string; input?: Record<string, unknown> } | undefined;
  if (!tool) return undefined;
  return describeToolUse(tool.name ?? "", tool.input ?? {});
}

function base(p: unknown): string {
  const s = typeof p === "string" ? p : "";
  return s.split("/").pop() || s;
}

function describeToolUse(name: string, input: Record<string, unknown>): string | undefined {
  switch (name) {
    case "Edit":
    case "MultiEdit":
    case "Write":
      return `Editing ${base(input.file_path)}`;
    case "Read":
      return `Reading ${base(input.file_path)}`;
    case "Bash": {
      const desc = typeof input.description === "string" ? input.description : "";
      return desc ? desc : "Running a command";
    }
    case "Grep":
    case "Glob":
      return "Searching the code";
    case "TodoWrite":
      return "Planning the fix";
    case "Task":
      return "Working on it";
    default:
      return name ? `Using ${name}` : undefined;
  }
}

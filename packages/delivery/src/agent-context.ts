// Teach the coding agent that Heckle exists and how to process its inbox, by writing the
// right context file per agent. Then "check Heckle" (and the auto-dispatch) just work,
// without the user explaining the workflow each time.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export type AgentKind = "claude-code" | "cursor" | "codex" | "all";

const MARK_START = "<!-- heckle:agent-context -->";
const MARK_END = "<!-- /heckle:agent-context -->";

// The shared instruction block appended to a project's agent context file.
const CONVENTION = `${MARK_START}
## Heckle QA inbox

This project uses Heckle, a local QA co-pilot. When a person tests the app and approves a
flag, Heckle writes a structured item to \`.heckle/inbox.md\`. When you are asked to "check
Heckle" or process the inbox (Heckle also dispatches this automatically after approval):

1. Read \`.heckle/inbox.md\`. Each item has an id, an intent (the instruction to act on), a
   severity (blocker/bug/polish), repro steps, and attached console/network context.
2. For each open item, treat the repro steps and the attached console errors / failed
   network calls as ground truth. Make the smallest correct fix and run the project's tests.
   If Heckle MCP is available, call \`heckle_check_regressions\` with changed files and
   \`run: true\`, then call \`heckle_mark_ready\`. A code diff alone is not Fixed. Mark the
   item done in \`.heckle/inbox.md\` only after verification (keep its id).
3. If an item is vague or you cannot reproduce it, do not guess. Note what you found under
   the item and leave it open.

One item, one focused change. Do not add unrequested work or rewrite the whole file.
${MARK_END}`;

// A richer, invokable Claude Code skill (dropped at .claude/skills/heckle/SKILL.md).
export const HECKLE_SKILL = `---
name: heckle
description: Process the Heckle QA inbox. Read .heckle/inbox.md and, for each open item, fix it using its repro steps and attached console/network context, run tests, and mark it done. Use when the user says "check Heckle", "go heckle", "process the inbox", or references .heckle/inbox.md.
---

# Heckle: process the QA inbox

Heckle is a local QA co-pilot. A person tested the app and flagged issues; each approved
item is written to \`.heckle/inbox.md\` as structured feedback with the receipts attached.

## When to use
The user says "check Heckle", "go heckle", "process the inbox", or points at
\`.heckle/inbox.md\`. Heckle's auto-dispatch also invokes this after an item is approved.

## Steps
1. Read \`.heckle/inbox.md\`. Each item has: an id, an intent (the instruction), a severity
   (blocker/bug/polish), repro steps, and attached console/network context (the receipts).
2. For each item still open (skip ones already marked done):
   - Reconstruct the problem from the repro steps plus the attached console errors and
     failed network calls. Those are the evidence; trust them over guessing.
   - Make the smallest correct fix. Do not add unrequested work.
   - Run the project's tests or build if present, and confirm the fix matches the intent.
   - If the Heckle MCP server is available, call \`heckle_check_regressions\` with the changed
     files and \`run: true\`, then call \`heckle_mark_ready\` for the issue. Do not claim Fixed
     from a code diff alone.
   - Mark the item done in \`.heckle/inbox.md\`, preserving its id.
3. If an item is vague or you cannot reproduce it, do not guess. Note what you found under
   the item and leave it open for the person to clarify.

## Definition of done
- \`heckle_check_regressions\` has been called with every changed file and \`run: true\`.
- \`heckle_mark_ready\` reports Fixed for the issue. A code diff or agent exit code is not proof.
- The matching inbox item is marked done without changing any other item.

## Rules
- The attached console/network refs are ground truth for what broke. Start there.
- One item, one focused change. Keep edits minimal and match the surrounding code.
- Never delete other items or rewrite \`.heckle/inbox.md\` wholesale; only update the item
  you addressed.
`;

export interface InstallResult {
  written: string[];
  skipped: string[];
}

// The per-agent doc file that carries the shared convention marker.
const AGENT_DOC: Record<Exclude<AgentKind, "all">, string> = {
  "claude-code": "CLAUDE.md",
  codex: "AGENTS.md",
  cursor: ".cursorrules",
};

function fileHasMark(path: string): boolean {
  return existsSync(path) && readFileSync(path, "utf8").includes(MARK_START);
}

// A project counts as taught if the doc carries the marker, or (claude-code) the skill is
// installed. The skill alone means someone chose to keep it without the CLAUDE.md block;
// re-appending the block would fight that choice.
function agentTaught(projectRoot: string, agent: Exclude<AgentKind, "all">): boolean {
  if (fileHasMark(resolve(projectRoot, AGENT_DOC[agent]))) return true;
  return agent === "claude-code" && existsSync(resolve(projectRoot, ".claude", "skills", "heckle", "SKILL.md"));
}

/** Is Heckle context already installed for this agent? ("all" = every agent). */
export function hasAgentContext(projectRoot: string, agent: AgentKind = "claude-code"): boolean {
  if (agent === "all") {
    return (Object.keys(AGENT_DOC) as Array<Exclude<AgentKind, "all">>).every((a) => agentTaught(projectRoot, a));
  }
  return agentTaught(projectRoot, agent);
}

/** Has any agent been taught about Heckle here? False means this is a first run. */
export function hasAnyAgentContext(projectRoot: string): boolean {
  return (Object.keys(AGENT_DOC) as Array<Exclude<AgentKind, "all">>).some((a) => agentTaught(projectRoot, a));
}

// Append the convention to a doc file (CLAUDE.md / AGENTS.md / .cursorrules), idempotently.
function appendConvention(path: string, res: InstallResult): void {
  const body = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (body.includes(MARK_START)) {
    res.skipped.push(path);
    return;
  }
  const sep = body ? (body.endsWith("\n") ? "\n" : "\n\n") : "";
  writeFileSync(path, body + sep + CONVENTION + "\n");
  res.written.push(path);
}

function writeSkill(projectRoot: string, res: InstallResult): void {
  const dir = resolve(projectRoot, ".claude", "skills", "heckle");
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, "SKILL.md");
  writeFileSync(path, HECKLE_SKILL);
  res.written.push(path);
}

/** Install Heckle context for the given agent(s) into projectRoot. Idempotent for the docs. */
export function installAgentContext(projectRoot: string, agent: AgentKind = "claude-code"): InstallResult {
  const res: InstallResult = { written: [], skipped: [] };
  const want = (a: AgentKind) => agent === "all" || agent === a;
  if (want("claude-code")) {
    appendConvention(resolve(projectRoot, "CLAUDE.md"), res);
    writeSkill(projectRoot, res);
  }
  if (want("codex")) appendConvention(resolve(projectRoot, "AGENTS.md"), res);
  if (want("cursor")) appendConvention(resolve(projectRoot, ".cursorrules"), res);
  return res;
}

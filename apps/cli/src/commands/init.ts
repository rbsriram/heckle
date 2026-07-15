// `heckle init`, teach your coding agent about Heckle: writes the inbox convention and a
// Claude Code skill so "check Heckle" and the auto-dispatch work without explaining it.
import { type AgentKind, installAgentContext } from "../../../../packages/delivery/src/index.ts";

export function runInit(argv: string[]): void {
  const i = argv.indexOf("--agent");
  const raw = i >= 0 ? argv[i + 1] : "claude-code";
  const valid: AgentKind[] = ["claude-code", "cursor", "codex", "all"];
  const agent: AgentKind = valid.includes(raw as AgentKind) ? (raw as AgentKind) : "claude-code";

  const res = installAgentContext(process.cwd(), agent);
  for (const p of res.written) console.log(`  wrote    ${rel(p)}`);
  for (const p of res.skipped) console.log(`  skipped  ${rel(p)} (already has Heckle context)`);
  console.log(
    res.written.length
      ? `\nHeckle context installed for ${agent}. Your agent now knows to process .heckle/inbox.md.`
      : `\nHeckle context already present for ${agent}.`,
  );
}

function rel(p: string): string {
  const cwd = process.cwd();
  return p.startsWith(cwd) ? p.slice(cwd.length + 1) : p;
}

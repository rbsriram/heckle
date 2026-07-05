// Render approved Feedback into the markdown an agent reads, the instruction plus the
// resolved console/network receipts. One format, shared by every adapter.
import type { ContextBundle, Feedback } from "@heckle/shared";

export function formatFeedbackMarkdown(
  feedback: Feedback,
  context: ContextBundle,
  opts: { ts?: number } = {},
): string {
  const consoleById = new Map(context.console.map((e) => [e.id, e]));
  const networkById = new Map(context.network.map((e) => [e.id, e]));
  const refConsole = feedback.context.consoleRefs.map((id) => consoleById.get(id)).filter((e) => e != null);
  const refNetwork = feedback.context.networkRefs.map((id) => networkById.get(id)).filter((e) => e != null);

  const lines: string[] = [];
  lines.push(`## ${feedback.intent}`);
  lines.push("");
  lines.push(`- **Severity:** ${feedback.severity}`);
  lines.push(`- **Flow:** ${feedback.target.flow ?? context.flow ?? "unknown"}`);
  if (feedback.target.selector) lines.push(`- **Selector:** \`${feedback.target.selector}\``);
  lines.push(`- **URL:** ${context.url}`);
  if (feedback.history) lines.push(`- **Memory:** ${feedback.history.note}`);
  lines.push("");

  if (feedback.repro.length) {
    lines.push("**Reproduce:**");
    feedback.repro.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    lines.push("");
  }
  if (refConsole.length) {
    lines.push("**Console:**");
    refConsole.forEach((e) => lines.push(`- \`${e.level}\` ${e.args.join(" ")}`));
    lines.push("");
  }
  if (refNetwork.length) {
    lines.push("**Network:**");
    refNetwork.forEach((e) => lines.push(`- ${e.method} ${e.url} -> ${e.status ?? "failed"}`));
    lines.push("");
  }
  if (feedback.fixHint) {
    lines.push(`**Fix hint:** ${feedback.fixHint}`);
    lines.push("");
  }
  const stamp = opts.ts ? ` · ${new Date(opts.ts).toISOString()}` : "";
  lines.push(`<sub>heckle ${feedback.id}${stamp}</sub>`);
  return lines.join("\n");
}

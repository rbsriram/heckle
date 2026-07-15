// Build the drafting prompt: loose speech + runtime context -> instructions for a model
// to emit one strict JSON Feedback draft. Kept tight and provider-neutral.
import type { ConsoleEntry, NetworkEntry } from "../../shared/src/index.ts";
import type { DraftRequest } from "./types.ts";

const MAX_ENTRIES = 12;

const SYSTEM = `You are Heckle's drafting model. Turn a developer's spoken or typed bug report,
plus the captured runtime context, into ONE structured instruction a coding agent can act on.

Output ONLY a single JSON object, no markdown, no code fences, no prose, no <think>. /no_think

Draft a task whenever the user expresses a concrete change they want. That is BOTH:
- bugs: something is broken, wrong, or the context shows an error, AND
- design / UX / copy changes: move, resize, restyle, recolor, reword, realign, spacing, layout,
  z-index/stacking, "make this bigger", "change how this looks", "I want that changed".
A change request is valid even when NOTHING is broken and there are NO console/network errors.
Use severity "polish" for cosmetic or UX-only changes. Never require an error to exist. If a
"Pointed at" element or selector is given below AND the report refers to it ("this / here /
that / it", or it plainly describes that element), set target.selector to that selector. If the
report is clearly about something else, ignore the pointed element and omit target.selector.

Only decline when the input is genuinely unusable: empty, gibberish (random characters), pure
filler or test noise, or no discernible request at all. In that case output EXACTLY:
{ "noIssue": true, "reason": "<one short sentence on why there is nothing to flag>" }

Otherwise output a draft with this schema:
{
  "intent": string,          // a clear, imperative instruction for the coding agent
  "target": { "selector"?: string, "flow"?: string },  // DOM selector if one element, else the flow
  "severity": "blocker" | "bug" | "polish",
  "repro": string[],         // concise steps to reproduce
  "context": {
    "consoleRefs": string[], // ids chosen from the Console list below that are relevant (else [])
    "networkRefs": string[]  // ids chosen from the Network list below that are relevant (else [])
  },
  "fixHint"?: string,        // optional suggested direction, not a command
  "assertions"?: [
    { "type": "text_equals", "target": { "testid"?: string, "role"?: string, "name"?: string, "css"?: string }, "expected": string }
    | { "type": "console_clean", "levels": ("log" | "info" | "warn" | "error" | "debug")[] }
    | { "type": "no_failed_requests", "exclude": string[] }
  ]
}

Rules: base the draft strictly on what the user reported, do not speculate or add unrequested
work. A successful action or a normal log is NOT a bug. consoleRefs/networkRefs MUST be ids that
appear in the lists provided; if none apply, use []. Severity from impact: blocker =
broken/unusable, bug = wrong behavior, polish = minor.
Propose only assertions directly supported by the user's words and captured evidence. Use text_equals
only when the expected text is explicit, console_clean for reported console errors, and
no_failed_requests for reported failed requests. Omit assertions when the expected result is unclear.`;

function renderConsole(entries: ConsoleEntry[]): string {
  if (!entries.length) return "(none)";
  return entries
    .slice(-MAX_ENTRIES)
    .map((e) => `[${e.id}] ${e.level}: ${e.args.join(" ").slice(0, 200)}`)
    .join("\n");
}

function renderNetwork(entries: NetworkEntry[]): string {
  if (!entries.length) return "(none)";
  return entries
    .slice(-MAX_ENTRIES)
    .map((e) => `[${e.id}] ${e.method} ${e.url} -> ${e.status ?? (e.ok === false ? "failed" : "?")}`)
    .join("\n");
}

export function buildDraftingPrompt(req: DraftRequest): { system: string; user: string } {
  const { transcript, context, related, insist } = req;
  const relatedText = related.length
    ? related.map((i) => `- [${i.status}] ${i.summary}`).join("\n")
    : "(none)";

  const sel = context.selection;
  const pointed = sel
    ? [
        sel.label || sel.selector ? `Pointed at: ${sel.label ?? ""} (selector: ${sel.selector ?? "n/a"})` : "",
        sel.target ? `Stable target: ${JSON.stringify(sel.target)}` : "",
        sel.text ? `Highlighted text: "${sel.text}"` : "",
      ].filter(Boolean)
    : [];

  const user = [
    `User said: "${transcript}"`,
    `Page: ${context.url}`,
    `Flow: ${context.flow ?? "unknown"}`,
    ...pointed,
    ``,
    `Console (id: level: message):`,
    renderConsole(context.console),
    ``,
    `Network (id: method url -> status):`,
    renderNetwork(context.network),
    ``,
    `Related prior issues:`,
    relatedText,
    // The user pushed back on a prior decline: they are telling us this IS a real problem.
    ...(insist
      ? [
          ``,
          `IMPORTANT: The user has reviewed a previous "nothing to flag" response and insists this` +
            ` IS a real, actionable problem. Trust them. Do NOT return noIssue. Draft the best` +
            ` actionable task you can from their report plus the context above, even if the signal` +
            ` is thin. If the context has no matching console/network ids, use [].`,
        ]
      : []),
  ].join("\n");

  return { system: SYSTEM, user };
}

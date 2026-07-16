// Fast-lane router: read the spoken/typed request and decide which lane it belongs to.
//   - "copy": a direct text change we can apply as a one-line source edit (needs the new text).
//   - "style": a visual tweak (color, size, spacing, visibility). Recognized for a future style
//     applier; until that exists the orchestrator routes it to the agent lane, same as behavioral.
//   - "behavioral": anything else (logic, data, flow). The full agent lane.
// Only "copy" changes behavior today, so copy detection is deliberately high-precision: when in
// doubt it returns behavioral and the request takes the safe, normal path.

export type Lane = "copy" | "style" | "behavioral";

export interface Classification {
  lane: Lane;
  newText?: string; // copy: the replacement text pulled from the request
  oldText?: string; // copy: explicit "replace X with Y" old text, overrides the pointed element's text
  reason: string; // short tag for logs and the approval card
}

const COLORS = new Set([
  "red", "blue", "green", "black", "white", "gray", "grey", "yellow", "orange",
  "purple", "pink", "teal", "cyan", "violet", "indigo", "navy", "gold", "silver",
  "brown", "maroon", "transparent",
]);

// Visual-tweak keywords. Color names are checked separately (COLORS) so "make it blue" is style.
const STYLE_RE =
  /\b(colou?rs?|background|darker|lighter|bigger|smaller|larger|bolder|bold|italic|underline|padding|margin|spacing|font[- ]?size|too (?:big|small|dark|light|wide|narrow|bright)|hide|invisible|move (?:it|this|that) (?:left|right|up|down|over)|align|cent(?:er|re)|round(?:ed)?|shadow|border)\b/i;
const COLOR_RE = new RegExp(`\\b(${[...COLORS].join("|")})\\b`, "i");

function extractQuoted(s: string): string | undefined {
  const m = s.match(/['"“”`]([^'"“”`\r\n]{1,120})['"“”`]/);
  return m ? m[1].trim() : undefined;
}

function cleanTail(s: string): string {
  return s
    .trim()
    .replace(/^['"“”`]+|['"“”`]+$/g, "")
    .replace(/[.!?,;:]+$/, "")
    .trim();
}

// A concrete replacement literal, not a rewrite request. "be more descriptive" or a long sentence
// is a fuzzy ask that belongs to the agent (or a future tiny-model tier), not a blind swap.
function looksLikeLiteral(s: string): boolean {
  if (s.length < 1 || s.length > 60) return false;
  if (/[\r\n]/.test(s)) return false;
  if (/^(be|being|to be|more|less|something|it should|shorter|longer)\b/i.test(s)) return false;
  return true;
}

// A value that describes appearance rather than copy: a color, a hex, a size word, a number+unit.
function isStyleValue(x: string): boolean {
  const t = cleanTail(x).toLowerCase();
  if (COLORS.has(t)) return true;
  if (/^#[0-9a-f]{3,8}$/i.test(t)) return true;
  if (/^(?:darker|lighter|bigger|smaller|larger|bold|bolder|italic)$/.test(t)) return true;
  if (/^\d+(?:\.\d+)?(?:px|rem|em|%|pt)$/.test(t)) return true;
  if (/^(?:rgb|rgba|hsl|hsla)\(/.test(t)) return true;
  return false;
}

function copy(newText: string, reason: string, oldText?: string): Classification {
  return { lane: "copy", newText, oldText, reason };
}

// Explicit copy phrasings. Each captures the new text in group 1.
const COPY_PATTERNS: RegExp[] = [
  /\bcall\s+(?:it|this)\s+(.+)$/i,
  /\brename\s+(?:it|this|the\s+[\w ]+?)\s+to\s+(.+)$/i,
  /\b(?:make|have)\s+(?:it|this|the\s+[\w ]+?)\s+(?:say|read)\s+(.+)$/i,
  /\b(?:it|this|the\s+[\w ]+?)\s+should\s+(?:say|read)\s+(.+)$/i,
  /\b(?:the\s+)?(?:copy|text|label|wording|title|heading|caption|placeholder)\s+(?:should\s+(?:be|say|read)|to\s+say|to)\s+(.+)$/i,
  /\bchange\s+(?:the\s+)?(?:copy|text|label|wording|title|heading|caption)\s+to\s+(.+)$/i,
];

export function classify(transcriptRaw: string): Classification {
  const t = transcriptRaw.trim();

  // 1) Explicit "replace X with Y" gives both the old and new text.
  const rep = t.match(/\breplace\s+(.+?)\s+with\s+(.+)$/i);
  if (rep) {
    const newText = extractQuoted(t) ?? cleanTail(rep[2]);
    if (looksLikeLiteral(newText)) return copy(newText, "replace-with", cleanTail(rep[1]));
  }

  // 2) Explicit copy verbs / nouns.
  for (const re of COPY_PATTERNS) {
    const g = t.match(re);
    if (g) {
      const newText = extractQuoted(t) ?? cleanTail(g[1]);
      if (looksLikeLiteral(newText)) return copy(newText, "copy-verb");
    }
  }

  // 3) Generic "change/make it to X": copy, unless X names an appearance value (color, size...).
  const gen = t.match(/\b(?:change|make|set|update|turn)\s+(?:it|this|that)\s+to\s+(.+)$/i);
  if (gen) {
    const val = cleanTail(gen[1]);
    if (isStyleValue(val)) return { lane: "style", reason: "to-style-value" };
    const newText = extractQuoted(t) ?? val;
    if (looksLikeLiteral(newText)) return copy(newText, "to-text");
  }

  // 4) Visual tweak keywords or a bare color word.
  if (STYLE_RE.test(t) || COLOR_RE.test(t)) return { lane: "style", reason: "style-keyword" };

  // 5) Default: the full agent lane.
  return { lane: "behavioral", reason: "no-fast-pattern" };
}

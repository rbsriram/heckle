// Fast-lane applier: turn a confident locate() match into a single, surgical source edit. It
// replaces exactly the one literal occurrence at the pinned line:column (never a blind global
// replace), after re-verifying the literal is still there, and refuses anything that would produce
// invalid markup. Returns the before/after content so the caller can offer one-key undo. Reads and
// writes are confined to the project root. When it refuses, the caller falls back to the agent lane.
import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveUnderRoot, type LiteralMatch } from "./locate.ts";

export interface ApplyRequest {
  match: LiteralMatch; // from locateLiteral: the exact file/line/column/kind to edit
  oldText: string; // the literal currently there (what was searched for)
  newText: string; // the replacement copy
}
export interface ApplyResult {
  ok: boolean;
  file: string; // absolute path, or the requested path when refused before resolution
  reason?: string; // why it was refused, so the caller can fall through to the agent lane
  before?: string; // original file content, for one-key undo
  after?: string; // new file content
  preview?: string; // "old -> new · file:line" for the approval card
}

// Reject any replacement that would break the surrounding markup, so a bad edit becomes a
// fall-through to the agent lane, never a corrupted file. Conservative on purpose.
function unsafeReason(kind: LiteralMatch["kind"], newText: string, quoteChar: string): string | undefined {
  if (newText.length === 0) return "empty";
  if (/[\r\n]/.test(newText)) return "newline";
  if (kind === "raw") return "not-a-literal"; // locate was not sure this was a real literal
  if (kind === "jsx-text" && /[<>{}]/.test(newText)) return "jsx-breaking-char";
  if (kind === "string" && quoteChar && newText.includes(quoteChar)) return "quote-in-string";
  return undefined;
}

// dryRun computes and validates the edit but does not touch disk, so the approval card can preview
// "old -> new" before the gate; the real write happens on approve with dryRun off.
export async function applyLiteralEdit(
  root: string,
  req: ApplyRequest,
  opts?: { dryRun?: boolean },
): Promise<ApplyResult> {
  const { match, oldText, newText } = req;
  const abs = resolveUnderRoot(root, match.file);
  if (!abs) return { ok: false, file: match.file, reason: "outside-root" };

  let before: string;
  try {
    before = await fs.readFile(abs, "utf8");
  } catch {
    return { ok: false, file: abs, reason: "unreadable" };
  }

  const lines = before.split("\n");
  const li = match.line - 1;
  if (li < 0 || li >= lines.length) return { ok: false, file: abs, reason: "line-out-of-range" };
  const line = lines[li];
  const col = match.column - 1;
  // Re-verify the literal is exactly where locate said. If the file moved since capture, refuse
  // rather than overwrite the wrong text.
  if (col < 0 || line.slice(col, col + oldText.length) !== oldText) {
    return { ok: false, file: abs, reason: "stale" };
  }

  const quoteChar = match.kind === "string" ? line[col - 1] ?? "" : "";
  const bad = unsafeReason(match.kind, newText, quoteChar);
  if (bad) return { ok: false, file: abs, reason: bad };

  lines[li] = line.slice(0, col) + newText + line.slice(col + oldText.length);
  const after = lines.join("\n");
  if (!opts?.dryRun) await fs.writeFile(abs, after, "utf8");

  const rel = path.relative(root, abs) || path.basename(abs);
  return {
    ok: true,
    file: abs,
    before,
    after,
    preview: `"${oldText}" -> "${newText}"  ·  ${rel}:${match.line}`,
  };
}

// Restore a file to its pre-edit content (one-key undo). Confined to the project root.
export async function revertEdit(root: string, file: string, before: string): Promise<boolean> {
  const abs = resolveUnderRoot(root, file);
  if (!abs) return false;
  try {
    await fs.writeFile(abs, before, "utf8");
    return true;
  } catch {
    return false;
  }
}

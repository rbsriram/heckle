// Fast-lane fallback: find where a literal (a button's copy, a label) lives in project source, so
// a direct edit can target it even without a framework dev hook. Two modes:
//   1. source-hint: confirm the literal at/near a file:line the browser resolved (React/Svelte/Vue).
//   2. grep: search the project's own source files for the exact literal.
// Read-only. Returns candidates plus a `confident` flag; the caller only auto-edits when confident,
// otherwise it falls through to the full agent lane. Never reads outside the project root.
import { promises as fs } from "node:fs";
import path from "node:path";

export interface LocateHint {
  file?: string;
  line?: number;
}
export interface LiteralMatch {
  file: string; // absolute path
  line: number; // 1-based
  column: number; // 1-based
  kind: "string" | "jsx-text" | "raw";
}
export interface LocateResult {
  matches: LiteralMatch[];
  confident: boolean;
  via: "source-hint" | "grep" | "none";
}

const SOURCE_EXTS = new Set([
  ".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs",
  ".vue", ".svelte", ".astro", ".html", ".htm",
]);
const IGNORE_DIRS = new Set([
  "node_modules", "dist", "build", "out", ".next", ".nuxt",
  ".svelte-kit", ".output", "coverage", ".heckle", ".vercel", ".git",
]);
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 5000;

// A match inside quotes ("copy") or between JSX tags (>copy<) is a real literal; a bare substring
// match is likely incidental (a comment, part of a longer word) and only used if nothing else hits.
function classify(lineText: string, idx: number, literal: string): LiteralMatch["kind"] {
  const before = lineText[idx - 1];
  const after = lineText[idx + literal.length];
  if (before && before === after && (before === '"' || before === "'" || before === "`")) return "string";
  if (before === ">" || after === "<") return "jsx-text";
  return "raw";
}

function findInContent(content: string, literal: string, absFile: string): LiteralMatch[] {
  const out: LiteralMatch[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    let from = 0;
    for (;;) {
      const idx = lineText.indexOf(literal, from);
      if (idx === -1) break;
      out.push({ file: absFile, line: i + 1, column: idx + 1, kind: classify(lineText, idx, literal) });
      from = idx + literal.length;
    }
  }
  return out;
}

async function walk(dir: string, acc: string[]): Promise<void> {
  if (acc.length >= MAX_FILES) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (acc.length >= MAX_FILES) return;
    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      await walk(path.join(dir, e.name), acc);
    } else if (e.isFile() && SOURCE_EXTS.has(path.extname(e.name))) {
      acc.push(path.join(dir, e.name));
    }
  }
}

// Never touch a path outside the project root (a source hint can carry an absolute path from a
// different checkout). Returns the absolute path when it is safely inside root, else undefined.
export function resolveUnderRoot(root: string, file: string): string | undefined {
  const normRoot = path.resolve(root);
  const abs = path.isAbsolute(file) ? path.resolve(file) : path.resolve(normRoot, file);
  if (abs === normRoot || abs.startsWith(normRoot + path.sep)) return abs;
  return undefined;
}

function nearest(matches: LiteralMatch[], line: number): LiteralMatch {
  return matches.reduce((best, m) => (Math.abs(m.line - line) < Math.abs(best.line - line) ? m : best));
}
function preferReal(matches: LiteralMatch[]): LiteralMatch {
  return matches.find((m) => m.kind !== "raw") ?? matches[0];
}

export async function locateLiteral(
  projectRoot: string,
  literalRaw: string,
  hint?: LocateHint,
): Promise<LocateResult> {
  const literal = literalRaw.trim();
  if (literal.length < 2) return { matches: [], confident: false, via: "none" };

  // 1) Source hint: the browser already resolved a file (and maybe a line). Confirm the literal
  // is there and pin the exact match. This is the precise, unambiguous path.
  if (hint?.file) {
    const abs = resolveUnderRoot(projectRoot, hint.file);
    if (abs) {
      try {
        const stat = await fs.stat(abs);
        if (stat.isFile() && stat.size <= MAX_FILE_BYTES) {
          const found = findInContent(await fs.readFile(abs, "utf8"), literal, abs);
          if (found.length) {
            const best = typeof hint.line === "number" ? nearest(found, hint.line) : preferReal(found);
            return { matches: [best], confident: true, via: "source-hint" };
          }
        }
      } catch {
        // fall through to grep
      }
    }
  }

  // 2) Grep: no usable hint (non-React/Svelte/Vue, transform off, prod). Search source for the
  // literal. Confident only when exactly one real (quoted / JSX-text) match exists.
  const files: string[] = [];
  await walk(path.resolve(projectRoot), files);
  const all: LiteralMatch[] = [];
  for (const f of files) {
    try {
      const stat = await fs.stat(f);
      if (stat.size > MAX_FILE_BYTES) continue;
      all.push(...findInContent(await fs.readFile(f, "utf8"), literal, f));
    } catch {
      // skip unreadable
    }
  }
  const real = all.filter((m) => m.kind !== "raw");
  const pool = real.length ? real : all;
  if (pool.length === 1) return { matches: pool, confident: true, via: "grep" };
  if (pool.length > 1) return { matches: pool, confident: false, via: "grep" };
  return { matches: [], confident: false, via: "none" };
}

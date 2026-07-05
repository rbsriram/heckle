// A persisted, viewable log of captures: what the user said, what was captured, and how it was
// resolved. Kept in .heckle/captures.json (a capped array, newest first) so the history survives
// restarts and spans sessions. Best-effort: any FS error degrades to an in-memory log.
import type { CaptureRecord } from "@heckle/shared";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const CAP = 50; // keep the last N captures

export interface CaptureLog {
  list(): CaptureRecord[];
  add(rec: CaptureRecord): void;
  // Mutators return the updated record (or undefined if the id is unknown) so the caller can
  // push it to live widgets.
  setOutcome(id: string, outcome: CaptureRecord["outcome"], extra?: Partial<CaptureRecord>): CaptureRecord | undefined;
  setProgress(id: string, line: string): CaptureRecord | undefined;
  remove(id: string): void;
}

export function createCaptureLog(projectRoot: string): CaptureLog {
  const dir = resolve(projectRoot, ".heckle");
  const path = resolve(dir, "captures.json");
  let records: CaptureRecord[] = [];
  try {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (Array.isArray(parsed)) records = parsed as CaptureRecord[];
    }
  } catch {
    records = []; // corrupt file -> start fresh rather than crash
  }

  const persist = () => {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, JSON.stringify(records.slice(0, CAP)));
    } catch {
      // best-effort: history stays in memory this session
    }
  };

  return {
    list: () => records.slice(0, CAP),
    add(rec) {
      records.unshift(rec);
      if (records.length > CAP) records = records.slice(0, CAP);
      persist();
    },
    setOutcome(id, outcome, extra) {
      const r = records.find((x) => x.id === id);
      if (!r) return undefined;
      r.outcome = outcome;
      if (extra) Object.assign(r, extra);
      persist();
      return r;
    },
    setProgress(id, line) {
      const r = records.find((x) => x.id === id);
      if (!r) return undefined;
      r.progress = line;
      persist();
      return r;
    },
    remove(id) {
      const before = records.length;
      records = records.filter((x) => x.id !== id);
      if (records.length !== before) persist();
    },
  };
}

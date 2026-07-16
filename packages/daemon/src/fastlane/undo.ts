import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { resolveUnderRoot } from "./locate.ts";

export interface UndoEntry {
  id: string;
  file: string;
  before: string;
  after: string;
  createdAt: string;
}

export class UndoStore {
  private readonly root: string;
  private readonly path: string;

  constructor(root: string) {
    this.root = root;
    this.path = resolve(root, ".heckle", "undo.json");
  }

  push(entry: UndoEntry): void {
    const entries = this.list();
    entries.unshift(entry);
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(entries.slice(0, 50), null, 2)}\n`);
  }

  list(): UndoEntry[] {
    if (!existsSync(this.path)) return [];
    try {
      const value = JSON.parse(readFileSync(this.path, "utf8"));
      return Array.isArray(value) ? value as UndoEntry[] : [];
    } catch {
      return [];
    }
  }

  undo(): UndoEntry {
    const entries = this.list();
    const entry = entries[0];
    if (!entry) throw new Error("nothing to undo");
    const file = resolveUnderRoot(this.root, entry.file);
    if (!file) throw new Error("undo target is outside the project");
    const current = readFileSync(file, "utf8");
    if (current !== entry.after) throw new Error("undo refused because the file changed after the instant edit");
    const temporary = `${file}.heckle-undo-${process.pid}.tmp`;
    writeFileSync(temporary, entry.before);
    renameSync(temporary, file);
    writeFileSync(this.path, `${JSON.stringify(entries.slice(1), null, 2)}\n`);
    return entry;
  }
}

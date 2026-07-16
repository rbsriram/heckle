import { UndoStore } from "../../../../packages/daemon/src/fastlane/undo.ts";

export function runUndo(argv: string[]): void {
  if (argv.length) throw new Error("usage: heckle undo");
  const entry = new UndoStore(process.cwd()).undo();
  console.log(`[heckle] undid ${entry.id}`);
}

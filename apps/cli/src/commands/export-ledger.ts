import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { openDb } from "../../../../packages/memory/src/index.ts";

export function runExportLedger(argv: string[], projectRoot: string = process.cwd()): void {
  if (argv.length > 1) throw new Error("usage: heckle export [file]");
  const output = resolve(projectRoot, argv[0] ?? ".heckle/ledger-export.json");
  const db = openDb(resolve(projectRoot, ".heckle", "heckle.db"));
  try {
    const data: Record<string, unknown[]> = {};
    for (const table of ["team_members", "issues", "issue_versions", "repros", "fixes", "sessions", "elements", "routes", "signals", "signal_versions", "ledger_events"]) {
      data[table] = db.prepare(`SELECT * FROM ${table}`).all() as unknown[];
    }
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify({ schema: "heckle-ledger@1", exported_at: new Date().toISOString(), data }, null, 2)}\n`);
  } finally {
    db.close();
  }
  console.log(`[heckle] exported local ledger to ${output}`);
}

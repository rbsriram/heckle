// Local issue store on the built-in node:sqlite. No native module, no server.
import { DatabaseSync } from "node:sqlite";

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS issues (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,            -- open | fixed | recurring
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      flow TEXT,
      summary TEXT NOT NULL,
      context_ref TEXT,                -- the feedback id that created/last touched this
      flagged_count INTEGER NOT NULL DEFAULT 1,
      embedding TEXT NOT NULL          -- JSON array of floats (nomic-embed-text)
    );
  `);
  return db;
}

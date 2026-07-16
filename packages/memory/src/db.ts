// Local issue store on the built-in node:sqlite. No native module, no server.
import { DatabaseSync } from "node:sqlite";

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((item) => item.name === column);
}

function addColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
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
  addColumn(db, "issues", "observed_at", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "issues", "valid_from", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "issues", "superseded_at", "INTEGER");
  addColumn(db, "issues", "authority", "TEXT NOT NULL DEFAULT 'human'");
  addColumn(db, "issues", "owner", "TEXT NOT NULL DEFAULT 'local'");
  addColumn(db, "issues", "source", "TEXT NOT NULL DEFAULT 'local'");
  db.exec(`
    CREATE TABLE IF NOT EXISTS ledger_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      payload TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      valid_from INTEGER NOT NULL,
      superseded_at INTEGER,
      authority TEXT NOT NULL,
      owner TEXT NOT NULL,
      source TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ledger_events_entity ON ledger_events(entity_type, entity_id, observed_at);
    CREATE TABLE IF NOT EXISTS issue_versions (
      version_id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id TEXT NOT NULL,
      status TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      valid_from INTEGER NOT NULL,
      superseded_at INTEGER,
      authority TEXT NOT NULL,
      owner TEXT NOT NULL,
      source TEXT NOT NULL,
      flow TEXT,
      summary TEXT NOT NULL,
      context_ref TEXT,
      flagged_count INTEGER NOT NULL,
      FOREIGN KEY(issue_id) REFERENCES issues(id)
    );
    CREATE TABLE IF NOT EXISTS repros (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      artifact_path TEXT NOT NULL,
      route TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'captured',
      observed_at INTEGER NOT NULL,
      valid_from INTEGER NOT NULL,
      superseded_at INTEGER,
      authority TEXT NOT NULL DEFAULT 'human',
      owner TEXT NOT NULL DEFAULT 'local',
      source TEXT NOT NULL DEFAULT 'local'
    );
    CREATE TABLE IF NOT EXISTS fixes (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      repro_id TEXT,
      diff TEXT,
      outcome TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      valid_from INTEGER NOT NULL,
      superseded_at INTEGER,
      authority TEXT NOT NULL,
      owner TEXT NOT NULL DEFAULT 'local',
      source TEXT NOT NULL DEFAULT 'local'
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      observed_at INTEGER NOT NULL,
      valid_from INTEGER NOT NULL,
      superseded_at INTEGER,
      authority TEXT NOT NULL DEFAULT 'human',
      owner TEXT NOT NULL DEFAULT 'local',
      source TEXT NOT NULL DEFAULT 'local'
    );
    CREATE TABLE IF NOT EXISTS elements (
      id TEXT PRIMARY KEY,
      stable_key TEXT NOT NULL UNIQUE,
      source_file TEXT,
      source_line INTEGER,
      source_column INTEGER,
      testid_history TEXT NOT NULL DEFAULT '[]',
      observed_at INTEGER NOT NULL,
      valid_from INTEGER NOT NULL,
      superseded_at INTEGER,
      authority TEXT NOT NULL DEFAULT 'human',
      owner TEXT NOT NULL DEFAULT 'local',
      source TEXT NOT NULL DEFAULT 'local'
    );
    CREATE TABLE IF NOT EXISTS routes (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      observed_at INTEGER NOT NULL,
      valid_from INTEGER NOT NULL,
      superseded_at INTEGER,
      authority TEXT NOT NULL DEFAULT 'human',
      owner TEXT NOT NULL DEFAULT 'local',
      source TEXT NOT NULL DEFAULT 'local'
    );
    CREATE TABLE IF NOT EXISTS signals (
      id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL UNIQUE,
      route TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 1,
      dismissed INTEGER NOT NULL DEFAULT 0,
      observed_at INTEGER NOT NULL,
      valid_from INTEGER NOT NULL,
      superseded_at INTEGER,
      authority TEXT NOT NULL DEFAULT 'heuristic',
      owner TEXT NOT NULL DEFAULT 'local',
      source TEXT NOT NULL DEFAULT 'local'
    );
  `);
  db.prepare(`UPDATE issues SET observed_at = CASE WHEN observed_at = 0 THEN created_at ELSE observed_at END,
    valid_from = CASE WHEN valid_from = 0 THEN created_at ELSE valid_from END`).run();
  db.prepare(`INSERT INTO issue_versions
    (issue_id,status,observed_at,valid_from,superseded_at,authority,owner,source,flow,summary,context_ref,flagged_count)
    SELECT id,status,observed_at,valid_from,NULL,authority,owner,source,flow,summary,context_ref,flagged_count
    FROM issues WHERE NOT EXISTS (SELECT 1 FROM issue_versions v WHERE v.issue_id = issues.id)`).run();
  db.exec(`PRAGMA user_version = 2;`);
  return db;
}

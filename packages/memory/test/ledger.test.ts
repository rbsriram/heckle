import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { ReproArtifact } from "../../shared/src/index.ts";
import { Ledger } from "../src/ledger.ts";
import { openDb } from "../src/db.ts";
import { Knot } from "../src/knot.ts";

test("migration creates every minimum ledger primitive and preserves an old issue", () => {
  const root = mkdtempSync(resolve(tmpdir(), "heckle-ledger-migrate-"));
  const path = resolve(root, "heckle.db");
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE issues (
    id TEXT PRIMARY KEY,status TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
    flow TEXT,summary TEXT NOT NULL,context_ref TEXT,flagged_count INTEGER NOT NULL DEFAULT 1,embedding TEXT NOT NULL
  )`);
  old.prepare(`INSERT INTO issues VALUES (?,?,?,?,?,?,?,?,?)`).run("iss_old", "open", 1, 1, null, "old issue", null, 1, "[]");
  old.close();

  const db = openDb(path);
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map((row) => row.name);
  for (const table of ["team_members", "issues", "issue_versions", "repros", "fixes", "sessions", "elements", "routes", "signals", "signal_versions", "ledger_events"]) {
    assert.ok(tables.includes(table), `created ${table}`);
  }
  assert.equal((db.prepare(`PRAGMA user_version`).get() as { user_version: number }).user_version, 5);
  assert.equal((db.prepare(`SELECT owner,source FROM issues WHERE id='iss_old'`).get() as { owner: string; source: string }).owner, "local");
  assert.equal((db.prepare(`SELECT count(*) AS n FROM issue_versions WHERE issue_id='iss_old'`).get() as { n: number }).n, 1);
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test("issue changes supersede prior versions instead of erasing them", async () => {
  const db = openDb(":memory:");
  const knot = new Knot(db, { embed: async () => Float32Array.from([1]) });
  const issue = await knot.addIssue({ summary: "checkout total" });
  knot.markFixed(issue.id, "verification");
  knot.bumpFlag(issue.id);
  const versions = db.prepare(
    `SELECT status,superseded_at,authority FROM issue_versions WHERE issue_id=? ORDER BY version_id`,
  ).all(issue.id) as Array<{ status: string; superseded_at: number | null; authority: string }>;
  assert.deepEqual(versions.map((version) => version.status), ["open", "fixed", "recurring"]);
  assert.ok(versions[0].superseded_at);
  assert.ok(versions[1].superseded_at);
  assert.equal(versions[2].superseded_at, null);
  assert.equal(versions[1].authority, "verification");
  knot.close();
});

test("Ledger records Repro, Fix, Session, Element, Route, and Signal facts with authority", () => {
  const root = mkdtempSync(resolve(tmpdir(), "heckle-ledger-"));
  const db = openDb(resolve(root, "heckle.db"));
  const ledger = new Ledger(db);
  const repro: ReproArtifact = {
    version: 1,
    id: "hkl_test",
    issue_id: "iss_test",
    created_at: new Date().toISOString(),
    origin: "http://localhost:3000",
    route: "/checkout",
    viewport: { width: 1280, height: 720 },
    state_seed: { localStorage: {}, sessionStorage: {}, cookies: [] },
    actions: [],
    network_fixtures: [],
    assertions: [],
    utterance: "test",
    determinism: { runs: 0, pass_rate: 0, quarantined: false },
  };
  ledger.recordRepro(repro, ".heckle/repros/hkl_test.json");
  ledger.recordVerification(repro, true, []);
  assert.equal((db.prepare(`SELECT status FROM repros WHERE id=?`).get(repro.id) as { status: string }).status, "fixed");
  const fixId = ledger.recordFix({ issueId: "iss_test", reproId: repro.id, outcome: "passed", authority: "verification" });
  const sessionId = ledger.startSession("reporter-a", "staging");
  ledger.endSession(sessionId);
  const elementId = ledger.recordElement({ stableKey: "src/Button.tsx:4:2", testid: "save", authority: "human" });
  assert.equal(ledger.recordElement({ stableKey: "src/Button.tsx:4:2", testid: "save-new", authority: "heuristic" }), elementId);
  const routeId = ledger.recordRoute("/checkout");
  const signalId = ledger.recordSignal("error|frame|route", "/checkout");
  ledger.recordSignal("error|frame|route", "/checkout");
  ledger.dismissSignal("error|frame|route");

  assert.ok(fixId.startsWith("fix_"));
  assert.ok(routeId.startsWith("rte_"));
  assert.ok(signalId.startsWith("sig_"));
  assert.equal((db.prepare(`SELECT authority FROM fixes WHERE id=?`).get(fixId) as { authority: string }).authority, "verification");
  assert.deepEqual(JSON.parse((db.prepare(`SELECT testid_history FROM elements WHERE id=?`).get(elementId) as { testid_history: string }).testid_history), ["save"]);
  assert.equal((db.prepare(`SELECT count FROM signals WHERE id=?`).get(signalId) as { count: number }).count, 2);
  assert.equal(ledger.signalDismissed("error|frame|route"), true);
  const signalVersions = db.prepare(`SELECT superseded_at,dismissed FROM signal_versions WHERE signal_id=? ORDER BY version_id`).all(signalId) as Array<{ superseded_at: number | null; dismissed: number }>;
  assert.deepEqual(signalVersions.map((version) => version.dismissed), [0, 0, 1]);
  assert.ok(signalVersions[0].superseded_at && signalVersions[1].superseded_at);
  assert.equal(signalVersions[2].superseded_at, null);
  assert.ok((db.prepare(`SELECT count(*) AS n FROM ledger_events`).get() as { n: number }).n >= 8);
  assert.equal(ledger.authorityWins("verification", "human"), true);
  assert.equal(ledger.authorityWins("heuristic", "agent"), false);
  ledger.close();
  rmSync(root, { recursive: true, force: true });
});

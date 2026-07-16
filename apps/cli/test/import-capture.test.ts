import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { runImportCapture } from "../src/commands/import-capture.ts";
import { runExportLedger } from "../src/commands/export-ledger.ts";

const payload = {
  schema: "heckle-capture@1",
  project: "staging-app",
  reporter: "reporter-a",
  source: "capture-only",
  created_at: "2026-07-01T00:00:00.000Z",
  route: "/checkout",
  origin: "https://staging.example.com",
  intent: "The place order button does nothing",
  repro: ["Click Place order"],
  evidence: { console_errors: ["Order failed"], failed_requests: ["500 /api/order"] },
};

test("a capture-only export lands in the developer queue with reporter ownership", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "heckle-import-"));
  try {
    writeFileSync(resolve(root, "capture.json"), JSON.stringify(payload));
    await runImportCapture(["capture.json"], root);
    const inbox = readFileSync(resolve(root, ".heckle", "inbox.md"), "utf8");
    assert.match(inbox, /place order button does nothing/i);
    assert.match(inbox, /Click Place order/);
    const db = new DatabaseSync(resolve(root, ".heckle", "heckle.db"));
    const issue = db.prepare(`SELECT owner,source,status FROM issues`).get() as { owner: string; source: string; status: string };
    assert.equal(issue.owner, "reporter-a");
    assert.equal(issue.source, "capture-only");
    assert.equal(issue.status, "open");
    const members = db.prepare(`SELECT id,role FROM team_members ORDER BY id`).all() as Array<{ id: string; role: string }>;
    assert.equal(members.some((member) => member.id === "reporter-a" && member.role === "reporter"), true);
    assert.equal(members.some((member) => member.id === "local" && member.role === "shipper"), true);
    db.close();
    const captures = JSON.parse(readFileSync(resolve(root, ".heckle", "captures.json"), "utf8")) as Array<{ owner?: string; source?: string }>;
    assert.equal(captures[0].owner, "reporter-a");
    assert.equal(captures[0].source, "capture-only");
    runExportLedger(["ledger.json"], root);
    const exported = JSON.parse(readFileSync(resolve(root, "ledger.json"), "utf8")) as { schema: string; data: { team_members: unknown[]; issues: unknown[] } };
    assert.equal(exported.schema, "heckle-ledger@1");
    assert.equal(exported.data.team_members.length, 2);
    assert.equal(exported.data.issues.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("capture-only import rejects malformed and executable origins", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "heckle-import-bad-"));
  try {
    writeFileSync(resolve(root, "bad.json"), JSON.stringify({ ...payload, origin: "javascript:alert(1)" }));
    await assert.rejects(runImportCapture(["bad.json"], root), /HTTP or HTTPS/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The task context receipt (GitHub issue #1): a compact proof of what was approved. Hashes and
// counts must be recomputable, raw captured content must never leak into the receipt, and the
// inbox item + fix prompt must reference the receipt path.
import type { ContextBundle, Feedback } from "@heckle/shared";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { buildFixPrompt } from "../src/agent-dispatch.ts";
import { formatFeedbackMarkdown } from "../src/format.ts";
import {
  buildTaskContextReceipt,
  FileInboxAdapter,
  RECEIPT_SCHEMA,
  receiptRelPath,
  removeTaskContextReceipt,
  writeTaskContextReceipt,
} from "../src/index.ts";

const feedback: Feedback = {
  id: "fb_1",
  intent: "Recompute the total when quantity changes",
  target: { flow: "checkout" },
  severity: "bug",
  repro: ["Open checkout", "Click +", "Total stays $20"],
  context: { consoleRefs: ["c1"], networkRefs: ["n1"] },
  history: null,
};

const context: ContextBundle = {
  url: "http://localhost:5173/checkout?step=2",
  flow: "checkout",
  console: [
    { id: "c0", level: "log", args: ["[checkout] placing order"], ts: 100 },
    { id: "c1", level: "error", args: ["TypeError: total is undefined"], ts: 150 },
  ],
  network: [{ id: "n1", method: "POST", url: "/api/order", status: 500, ok: false, ts: 120 }],
  rrwebEvents: [{}, {}, {}],
  capturedAt: 200,
};

const dispatch = { agent: "claude-code", sessionMode: "persistent", permissionMode: "acceptEdits", allowedTools: ["npm test"], userEdited: false };

function sha256(s: string): string {
  return "sha256:" + createHash("sha256").update(s).digest("hex");
}

test("buildTaskContextReceipt: recomputable hashes, no raw captured content", () => {
  const r = buildTaskContextReceipt({
    feedback,
    context,
    transcript: "the total is wrong",
    captureId: "trg_1",
    localOnly: true,
    dispatch,
    now: 1000,
  });

  assert.equal(r.schema, RECEIPT_SCHEMA);
  assert.equal(r.task_id, "fb_1");
  assert.equal(r.capture_id, "trg_1");
  assert.equal(r.app_url_origin, "http://localhost:5173");
  assert.equal(r.route_or_path, "/checkout?step=2");

  // Every hash is recomputable from its stated input.
  assert.equal(r.user_report_hash, sha256("the total is wrong"));
  assert.equal(r.task_hash, sha256(formatFeedbackMarkdown(feedback, context)));
  assert.equal(r.capture_window.context_hash, sha256(JSON.stringify(context)));

  // Counts + window, honest to the bundle.
  assert.equal(r.capture_window.started_at, new Date(100).toISOString());
  assert.equal(r.capture_window.ended_at, new Date(200).toISOString());
  assert.equal(r.capture_window.event_count, 3);
  assert.equal(r.capture_window.console_count, 2);
  assert.equal(r.capture_window.console_error_count, 1);
  assert.equal(r.capture_window.network_count, 1);
  assert.equal(r.capture_window.network_error_count, 1);

  // The dispatch posture is the approval's, verbatim.
  assert.equal(r.dispatch.approved_by_user, true);
  assert.equal(r.dispatch.agent, "claude-code");
  assert.equal(r.dispatch.session_mode, "persistent");
  assert.equal(r.dispatch.permission_mode, "acceptEdits");
  assert.deepEqual(r.dispatch.allowed_tools, ["npm test"]);
  assert.equal(r.dispatch.user_edited, false);
  assert.ok(r.stale_if.length > 0);

  // Safe to paste: raw console text and network URLs stay out of the receipt.
  const json = JSON.stringify(r);
  assert.ok(!json.includes("TypeError"), "console text leaked");
  assert.ok(!json.includes("/api/order"), "network url leaked");
  assert.ok(!json.includes("the total is wrong"), "raw report leaked");
  assert.equal(r.privacy.raw_payloads_included, false);
  assert.equal(r.privacy.local_only, true);
  assert.ok(r.privacy.not_captured.includes("request_bodies"), "no bodies captured -> said so");
});

test("privacy.not_captured drops the body claim when a bundle carries one", () => {
  const withBody: ContextBundle = {
    ...context,
    network: [{ id: "n1", method: "POST", url: "/api/order", status: 500, ok: false, ts: 120, requestBody: "{}" }],
  };
  const r = buildTaskContextReceipt({ feedback, context: withBody, localOnly: false, dispatch });
  assert.ok(!r.privacy.not_captured.includes("request_bodies"));
  assert.ok(r.privacy.not_captured.includes("cookies"), "header/cookie claim stands");
});

test("write + remove round-trip under .heckle/receipts/", () => {
  const root = mkdtempSync(resolve(tmpdir(), "heckle-rcpt-"));
  try {
    const receipt = buildTaskContextReceipt({ feedback, context, localOnly: true, dispatch, now: 1000 });
    const path = writeTaskContextReceipt(root, receipt);
    assert.equal(path, resolve(root, receiptRelPath("fb_1")));
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(parsed.schema, RECEIPT_SCHEMA);
    assert.equal(parsed.task_id, "fb_1");

    removeTaskContextReceipt(root, "fb_1");
    assert.ok(!existsSync(path), "receipt removed with its item");
    removeTaskContextReceipt(root, "fb_1"); // idempotent
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the inbox item and the fix prompt reference the receipt path", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "heckle-rcptref-"));
  try {
    const inbox = new FileInboxAdapter(root);
    const res = await inbox.deliver(feedback, context);
    assert.ok(res.ok);
    assert.match(readFileSync(inbox.path, "utf8"), /\*\*Receipt:\*\* `\.heckle\/receipts\/fb_1\.json`/);

    assert.ok(buildFixPrompt(feedback, context).includes(receiptRelPath("fb_1")));

    // The canonical markdown (what task_hash covers) does NOT carry the receipt/timestamp lines.
    assert.ok(!formatFeedbackMarkdown(feedback, context).includes("Receipt:"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

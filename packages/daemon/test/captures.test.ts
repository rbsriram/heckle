// The persisted, viewable capture history: add/list/setOutcome + survives across sessions.
import type { CaptureRecord, HeckleConfig, ServerMessage } from "@heckle/shared";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { createCaptureLog } from "../src/captures.ts";
import { Orchestrator } from "../src/orchestrator.ts";

function rec(id: string, outcome: CaptureRecord["outcome"] = "capturing"): CaptureRecord {
  return {
    id,
    ts: 1,
    url: "http://localhost:5173/",
    transcript: `t${id}`,
    console: [],
    network: [],
    stats: { console: 0, network: 0, rrweb: 0 },
    outcome,
  };
}

test("captureLog: newest-first, setOutcome updates, persists + reloads across sessions", () => {
  const root = mkdtempSync(resolve(tmpdir(), "heckle-cap-"));
  try {
    const log = createCaptureLog(root);
    log.add(rec("a"));
    log.add(rec("b"));
    assert.deepEqual(
      log.list().map((r) => r.id),
      ["b", "a"],
    );
    log.setOutcome("a", "noissue", { reason: "too vague" });
    const a = log.list().find((r) => r.id === "a");
    assert.equal(a?.outcome, "noissue");
    assert.equal(a?.reason, "too vague");
    assert.ok(existsSync(resolve(root, ".heckle/captures.json")));

    // A new session (fresh log) loads the persisted history + the updated outcome.
    const reloaded = createCaptureLog(root);
    assert.deepEqual(
      reloaded.list().map((r) => r.id),
      ["b", "a"],
    );
    assert.equal(reloaded.list().find((r) => r.id === "a")?.outcome, "noissue");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a trigger with a trimmed context (no console/network arrays) is recorded, not a crash", () => {
  const root = mkdtempSync(resolve(tmpdir(), "heckle-cap-"));
  try {
    const config = {
      drafting: { provider: "ollama", model: "x", baseUrl: "y" },
      voice: { provider: "local" },
      delivery: { order: ["file-inbox"] },
      agent: "claude-code",
      privacy: { localOnly: true },
    } as HeckleConfig;
    const orch = new Orchestrator(config, root, { provider: null, memory: null, metrics: null, verification: null });
    const replies: ServerMessage[] = [];
    // Only a url: a hand-rolled ws client or a stale widget bundle must not kill the daemon
    // (captureRecordFrom runs synchronously in the ws handler, before any try/catch).
    orch.handleMessage(
      JSON.stringify({ type: "trigger", intentText: "the page is broken", context: { url: "http://localhost/" } }),
      (m) => replies.push(m),
    );
    assert.equal(replies[0]?.type, "ack");
    orch.handleMessage(JSON.stringify({ type: "history" }), (m) => replies.push(m));
    const hist = replies.find((r) => r.type === "history");
    assert.equal(hist?.type === "history" ? hist.captures[0]?.console.length : -1, 0);
    assert.equal(hist?.type === "history" ? hist.captures[0]?.network.length : -1, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("captureLog: caps at 50, keeps the newest", () => {
  const root = mkdtempSync(resolve(tmpdir(), "heckle-cap-"));
  try {
    const log = createCaptureLog(root);
    for (let i = 0; i < 60; i++) log.add(rec(String(i)));
    const list = log.list();
    assert.equal(list.length, 50);
    assert.equal(list[0].id, "59"); // newest
    assert.equal(list[49].id, "10"); // oldest kept
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// M6: instrumentation. The Metrics log + the orchestrator emitting events at each step.
import type { HeckleConfig, ServerMessage } from "@heckle/shared";
import type { ModelProvider } from "@heckle/providers";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { formatMetrics, Metrics } from "../src/metrics.ts";
import { Orchestrator } from "../src/orchestrator.ts";

const config: HeckleConfig = {
  drafting: { provider: "ollama", model: "qwen3:14b", baseUrl: "http://localhost:11434/v1" },
  voice: { provider: "local" },
  delivery: { order: ["claude-code", "file-inbox", "clipboard"] },
  agent: "claude-code",
  privacy: { localOnly: true },
};

const stubProvider: ModelProvider = {
  name: "stub",
  async draft() {
    return {
      intent: "Recompute the total",
      target: { flow: "checkout" },
      severity: "bug",
      repro: ["x"],
      context: { consoleRefs: [], networkRefs: [] },
    };
  },
};

const context = {
  url: "http://localhost:5173/checkout",
  flow: "checkout",
  console: [],
  network: [],
  capturedAt: 1,
};

async function waitFor<T>(get: () => T | undefined, ms = 2000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("Metrics records events, computes activation + retention", () => {
  const m = new Metrics(new DatabaseSync(":memory:"));
  m.record("session_start");
  m.record("heckle_triggered", { triggerId: "t1" });
  m.record("draft_created", { feedbackId: "f1" });
  m.record("draft_approved", { feedbackId: "f1" });
  assert.equal(m.activation().activated, false);
  m.record("fix_landed", { feedbackId: "f1" });

  const s = m.summary();
  assert.equal(s.counts.heckle_triggered, 1);
  assert.equal(s.counts.fix_landed, 1);
  assert.equal(s.activation.activated, true);
  assert.equal(s.retentionWeeks[0].week, 1);
  assert.match(formatMetrics(s), /activated/);
  m.close();
});

test("orchestrator emits session_start / heckle_triggered / draft_created / draft_approved", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "heckle-m6-"));
  try {
    const metrics = new Metrics(new DatabaseSync(":memory:"));
    const orch = new Orchestrator(config, root, {
      provider: stubProvider,
      memory: null,
      metrics,
      verification: null,
      delivery: { whichFn: async () => false }, // no claude -> file-inbox floor, no fix_landed
    });
    assert.equal(metrics.counts().session_start, 1, "session_start on construct");

    const replies: ServerMessage[] = [];
    const reply = (m: ServerMessage) => replies.push(m);

    orch.handleMessage(JSON.stringify({ type: "trigger", intentText: "the total is wrong", context }), reply);
    const draft = await waitFor(() => replies.find((r) => r.type === "draft"));
    if (draft.type !== "draft") throw new Error("no draft");

    orch.handleMessage(JSON.stringify({ type: "approve", feedbackId: draft.feedback.id }), reply);
    await waitFor(() => replies.find((r) => r.type === "delivered"));

    const c = metrics.counts();
    assert.equal(c.heckle_triggered, 1);
    assert.equal(c.draft_created, 1);
    assert.equal(c.draft_approved, 1);
    metrics.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

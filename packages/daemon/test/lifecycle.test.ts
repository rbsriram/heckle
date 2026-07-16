// The memory lifecycle: a draft opens an issue; approving + a completed Claude Code fix
// marks it fixed; re-flagging the same issue then surfaces "fixed and it's back" (recurring).
// Fake embedder + fake spawn keep it deterministic (no Ollama, no real claude).
import type { HeckleConfig, ServerMessage } from "@heckle/shared";
import type { ModelProvider } from "@heckle/providers";
import type { SpawnFn } from "@heckle/delivery";
import { type Embedder, Knot, openDb } from "@heckle/memory";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { Orchestrator } from "../src/orchestrator.ts";

const VOCAB = ["total", "update", "quantity", "order", "500", "button", "checkout", "login", "slow", "page"];
class FakeEmbedder implements Embedder {
  async embed(t: string): Promise<Float32Array> {
    const s = t.toLowerCase();
    return Float32Array.from(VOCAB.map((w) => (s.includes(w) ? 1 : 0)));
  }
}

const stubProvider: ModelProvider = {
  name: "stub",
  async draft() {
    return {
      intent: "Recompute the order total on quantity change",
      target: { flow: "checkout" },
      severity: "bug",
      repro: ["x"],
      context: { consoleRefs: [], networkRefs: [] },
    };
  },
};

// A fake claude process that "succeeds", fires exit(0) once handlers are attached.
const fakeSpawn: SpawnFn = () => {
  const handlers: Record<string, (...a: unknown[]) => void> = {};
  setTimeout(() => handlers["exit"]?.(0), 0);
  return { on: (e: string, cb: (...a: unknown[]) => void) => (handlers[e] = cb), unref: () => {}, stdin: { end: () => {} } };
};

const config: HeckleConfig = {
  drafting: { provider: "ollama", model: "qwen3:14b", baseUrl: "http://localhost:11434/v1" },
  voice: { provider: "local" },
  delivery: { order: ["claude-code", "file-inbox", "clipboard"] },
  agent: "claude-code",
  privacy: { localOnly: true },
};

const context = { url: "http://localhost:5173/checkout", flow: "checkout", console: [], network: [], capturedAt: 1 };

async function waitFor<T>(get: () => T | undefined, ms = 2000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("failed replay verification appends evidence and dispatches one retry", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "heckle-verify-retry-"));
  try {
    let calls = 0;
    const orch = new Orchestrator(config, root, {
      provider: stubProvider,
      memory: null,
      metrics: null,
      ledger: null,
      verification: {
        async verify(artifact) {
          calls += 1;
          const fixed = calls === 2;
          return {
            reproId: artifact.id,
            issueId: artifact.issue_id,
            status: fixed ? "fixed" : "didnt_land",
            promoted: fixed,
            results: [],
            delta: fixed ? [] : ["text_equals expected \"$40\", observed \"$20\""],
          };
        },
      },
      delivery: { whichFn: async () => true, spawnFn: fakeSpawn },
    });
    const replies: ServerMessage[] = [];
    orch.setEmitter((message) => replies.push(message));
    const reply = (message: ServerMessage) => replies.push(message);
    orch.handleMessage(JSON.stringify({ type: "trigger", intentText: "the total doesn't update", context }), reply);
    const draft = await waitFor(() => replies.find((message) => message.type === "draft"));
    if (draft.type !== "draft") throw new Error("no draft");
    orch.handleMessage(JSON.stringify({ type: "approve", feedbackId: draft.feedback.id }), reply);
    await waitFor(() => replies.find((message) => message.type === "fixStatus" && message.ok));
    assert.equal(calls, 2);
    const inbox = readFileSync(resolve(root, ".heckle", "inbox.md"), "utf8");
    assert.match(inbox, /Verification failed/);
    assert.match(inbox, /observed \"\$20\"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("draft opens issue; approved + completed fix marks it fixed; re-flag -> recurring", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "heckle-life-"));
  try {
    const memory = new Knot(openDb(":memory:"), new FakeEmbedder());
    let verificationRuns = 0;
    const orch = new Orchestrator(config, root, {
      provider: stubProvider,
      memory,
      metrics: null,
      verification: {
        async verify(artifact) {
          verificationRuns += 2;
          return {
            reproId: artifact.id,
            issueId: artifact.issue_id,
            status: "fixed",
            promoted: true,
            results: [],
            delta: [],
          };
        },
      },
      delivery: { whichFn: async () => true, spawnFn: fakeSpawn }, // claude "available", fix succeeds
    });
    const replies: ServerMessage[] = [];
    const reply = (m: ServerMessage) => replies.push(m);

    // 1) flag -> draft opens an issue (status open)
    orch.handleMessage(JSON.stringify({ type: "trigger", intentText: "the total doesn't update", context }), reply);
    const d1 = await waitFor(() => replies.find((r) => r.type === "draft"));
    if (d1.type !== "draft") throw new Error("no draft1");
    assert.equal(d1.feedback.history, null);
    assert.equal(memory.list()[0].status, "open");

    // 2) approve -> dispatch -> fake fix exits 0 -> issue marked fixed
    orch.handleMessage(JSON.stringify({ type: "approve", feedbackId: d1.feedback.id }), reply);
    await waitFor(() => replies.find((r) => r.type === "delivered"));
    await waitFor(() => (memory.list()[0]?.status === "fixed" ? true : undefined), 1000);
    assert.equal(memory.list()[0].status, "fixed");
    assert.equal(verificationRuns, 2);

    // 3) re-flag the same issue -> "fixed and it's back" (recurring)
    replies.length = 0;
    orch.handleMessage(
      JSON.stringify({ type: "trigger", intentText: "the order total is wrong for this quantity", context }),
      reply,
    );
    const d2 = await waitFor(() => replies.find((r) => r.type === "draft"));
    if (d2.type !== "draft") throw new Error("no draft2");
    assert.equal(d2.feedback.history?.kind, "recurring");
    assert.match(d2.feedback.history?.note ?? "", /back/i);

    memory.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// M5: the hero moment through the orchestrator. A fake embedder + stub provider make it
// deterministic (no Ollama). First flag stores an issue (no history); a related re-flag
// surfaces "you flagged this before and it's still open".
import type { HeckleConfig, ServerMessage } from "@heckle/shared";
import type { ModelProvider } from "@heckle/providers";
import { type Embedder, Knot, openDb } from "@heckle/memory";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
      repro: ["Click +", "Total stays $20"],
      context: { consoleRefs: ["c1"], networkRefs: ["n1"] },
    };
  },
};

const config: HeckleConfig = {
  drafting: { provider: "ollama", model: "qwen3:14b", baseUrl: "http://localhost:11434/v1" },
  voice: { provider: "local" },
  delivery: { order: ["claude-code", "file-inbox", "clipboard"] },
  agent: "claude-code",
  privacy: { localOnly: true },
};

const context = {
  url: "http://localhost:5173/checkout",
  flow: "checkout",
  console: [{ id: "c1", level: "error" as const, args: ["total is undefined"], ts: 1 }],
  network: [{ id: "n1", method: "POST", url: "/api/order", status: 500, ok: false, ts: 2 }],
  capturedAt: 3,
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

test("first flag stores issue; related re-flag surfaces the still-open hero moment", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "heckle-m5-"));
  try {
    const memory = new Knot(openDb(":memory:"), new FakeEmbedder());
    const orch = new Orchestrator(config, root, { provider: stubProvider, memory, metrics: null, verification: null });

    const replies: ServerMessage[] = [];
    const reply = (m: ServerMessage) => replies.push(m);

    // 1st heckle, empty memory, so no history; an issue gets stored.
    orch.handleMessage(JSON.stringify({ type: "trigger", intentText: "the total doesn't update", context }), reply);
    const draft1 = await waitFor(() => replies.find((r) => r.type === "draft"));
    if (draft1.type !== "draft") throw new Error("no draft1");
    assert.equal(draft1.feedback.history, null, "first flag has no history");

    // 2nd heckle, semantically related (order/total/quantity) -> the hero moment.
    replies.length = 0;
    orch.handleMessage(
      JSON.stringify({ type: "trigger", intentText: "the order total is wrong for this quantity", context }),
      reply,
    );
    const draft2 = await waitFor(() => replies.find((r) => r.type === "draft"));
    if (draft2.type !== "draft") throw new Error("no draft2");
    assert.ok(draft2.feedback.history, "second flag carries history");
    assert.equal(draft2.feedback.history?.kind, "still-open");
    assert.match(draft2.feedback.history?.note ?? "", /flagged this before/i);

    memory.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

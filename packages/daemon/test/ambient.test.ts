import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import type { AmbientSignal, HeckleConfig, ServerMessage } from "../../shared/src/index.ts";
import type { ModelProvider } from "../../providers/src/index.ts";
import { Orchestrator } from "../src/orchestrator.ts";

const config: HeckleConfig = {
  drafting: { provider: "ollama", model: "test", baseUrl: "http://localhost:11434/v1" },
  voice: { provider: "local" },
  delivery: { order: ["file-inbox"] },
  agent: "none",
  privacy: { localOnly: true },
};

const provider: ModelProvider = {
  name: "ambient-test",
  async draft() {
    return {
      intent: "Handle the repeated checkout failure",
      target: { flow: "checkout" },
      severity: "bug",
      repro: ["Click submit"],
      context: { consoleRefs: [], networkRefs: [] },
    };
  },
};

const context = {
  url: "http://localhost:3000/checkout",
  console: [],
  network: [],
  actions: [{ type: "click" as const, target: { testid: "submit" }, ts: 1 }],
  capturedAt: 2,
};

function signal(fingerprint: string, count: number, proposed = false): AmbientSignal {
  return {
    fingerprint,
    kind: "network",
    summary: "POST /api/order -> 500",
    route: "/checkout",
    count,
    userVisible: true,
    context: proposed ? context : undefined,
  };
}

test("ambient signals deduplicate, promote through review, and remember dismissal", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "heckle-ambient-"));
  try {
    const orchestrator = new Orchestrator(config, root, {
      provider,
      memory: null,
      metrics: null,
      verification: null,
      delivery: { whichFn: async () => false },
    });
    const replies: ServerMessage[] = [];
    const reply = (message: ServerMessage) => replies.push(message);
    orchestrator.handleMessage(JSON.stringify({ type: "ambientSignal", signal: signal("fp-order", 1) }), reply);
    orchestrator.handleMessage(JSON.stringify({ type: "ambientSignal", signal: signal("fp-order", 2, true) }), reply);
    orchestrator.handleMessage(JSON.stringify({ type: "ambientSignal", signal: signal("fp-order", 40) }), reply);
    const digest = replies.filter((message) => message.type === "ambientDigest").at(-1);
    assert.equal(digest?.type, "ambientDigest");
    if (digest?.type !== "ambientDigest") throw new Error("no digest");
    assert.equal(digest.count, 1);
    assert.equal(digest.proposals[0].count, 40);

    orchestrator.handleMessage(JSON.stringify({ type: "ambientPromote", fingerprint: "fp-order" }), reply);
    for (let attempt = 0; attempt < 50 && !replies.some((message) => message.type === "draft"); attempt++) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    assert.ok(replies.some((message) => message.type === "draft"));

    orchestrator.handleMessage(JSON.stringify({ type: "ambientSignal", signal: signal("fp-dismiss", 2, true) }), reply);
    orchestrator.handleMessage(JSON.stringify({ type: "ambientDismiss", fingerprint: "fp-dismiss" }), reply);
    replies.length = 0;
    orchestrator.handleMessage(JSON.stringify({ type: "ambientSignal", signal: signal("fp-dismiss", 3, true) }), reply);
    assert.equal(replies.length, 0);
    orchestrator.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// M2 integration: local Ollama (qwen3:14b) drafts a schema-valid Feedback from the
// buggy-checkout context. Gated on Ollama running, so the suite stays green offline.
import type { ContextBundle, HeckleConfig } from "@heckle/shared";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createProvider } from "../src/index.ts";

const OLLAMA = "http://localhost:11434";

const ollamaUp = await (async () => {
  try {
    const r = await fetch(`${OLLAMA}/api/tags`);
    return r.ok;
  } catch {
    return false;
  }
})();

const config: HeckleConfig = {
  drafting: { provider: "ollama", model: "qwen3:14b", baseUrl: `${OLLAMA}/v1` },
  voice: { provider: "local" },
  delivery: { order: ["claude-code", "file-inbox", "clipboard"] },
  agent: "claude-code",
  privacy: { localOnly: true },
};

function checkoutBundle(): ContextBundle {
  return {
    url: "http://localhost:5173/checkout",
    flow: "checkout",
    console: [
      { id: "c1", level: "log", args: ["[checkout] placing order", '{"qty":11}'], ts: 1 },
      { id: "c2", level: "error", args: ["[checkout] order failed with status", "500"], ts: 2 },
    ],
    network: [{ id: "n1", method: "POST", url: "/api/order", status: 500, ok: false, durationMs: 12, ts: 3 }],
    rrwebEvents: [],
    capturedAt: 4,
  };
}

test(
  "ollama drafts a schema-valid Feedback for the 500 on submit",
  { skip: ollamaUp ? false : "Ollama not running on :11434", timeout: 120_000 },
  async () => {
    const provider = createProvider(config);
    const draft = await provider.draft({
      transcript: "the place order button throws a 500 on submit",
      context: checkoutBundle(),
      related: [],
    });

    // Schema-valid (createProvider validates internally, but assert the shape we depend on).
    assert.ok(["blocker", "bug", "polish"].includes(draft.severity), `severity=${draft.severity}`);
    assert.ok(draft.intent.length > 0, "has an intent");
    assert.ok(Array.isArray(draft.repro), "has repro steps");
    assert.ok(Array.isArray(draft.context.networkRefs), "has networkRefs array");
    // Log what the local model produced so we can eyeball quality.
    console.log("[ollama draft]", JSON.stringify(draft));
  },
);

// M5: knot-lite store + recall + history mapping. A fake deterministic embedder makes
// cosine predictable, so these run with no Ollama dependency.
import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../src/db.ts";
import { historyFor, Knot } from "../src/knot.ts";
import type { Embedder } from "../src/embed.ts";

const VOCAB = ["total", "update", "quantity", "order", "500", "button", "checkout", "login", "slow", "page"];
class FakeEmbedder implements Embedder {
  async embed(t: string): Promise<Float32Array> {
    const s = t.toLowerCase();
    return Float32Array.from(VOCAB.map((w) => (s.includes(w) ? 1 : 0)));
  }
}

function knot(): Knot {
  return new Knot(openDb(":memory:"), new FakeEmbedder());
}

test("addIssue + recall finds related, ignores unrelated", async () => {
  const k = knot();
  await k.addIssue({ summary: "Recompute the order total when quantity changes", flow: "checkout", contextRef: "fb1" });
  const related = await k.recall("the order total is wrong for this quantity");
  assert.equal(related.length, 1);
  assert.ok(related[0].score >= 0.65, `score ${related[0].score}`);
  const none = await k.recall("the login page is slow");
  assert.equal(none.length, 0);
  k.close();
});

test("bumpFlag increments; historyFor maps open -> still-open, 3x -> recurring", async () => {
  const k = knot();
  const iss = await k.addIssue({ summary: "order total quantity" });
  assert.equal((await k.recall("order total quantity"))[0].issue.status, "open");

  let count = k.bumpFlag(iss.id);
  assert.equal(count, 2);
  assert.equal(historyFor({ ...iss, status: "open" }, count).kind, "still-open");

  count = k.bumpFlag(iss.id);
  assert.equal(count, 3);
  assert.equal(historyFor({ ...iss, status: "open" }, count).kind, "recurring");
  k.close();
});

test("markFixed then re-flag -> recurring (it's back)", async () => {
  const k = knot();
  const iss = await k.addIssue({ summary: "order total quantity" });
  k.markFixed(iss.id);
  const r = await k.recall("order total quantity");
  assert.equal(r[0].issue.status, "fixed");
  const count = k.bumpFlag(iss.id);
  assert.equal(historyFor(r[0].issue, count).kind, "recurring");
  k.close();
});

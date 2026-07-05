// M5 integration: real nomic-embed-text recall. Gated on Ollama, so the suite stays green
// offline. Verifies a same-bug paraphrase recalls while unrelated feedback does not.
import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../src/db.ts";
import { Knot } from "../src/knot.ts";
import { OllamaEmbedder } from "../src/embed.ts";

const ollamaUp = await (async () => {
  try {
    return (await fetch("http://localhost:11434/api/tags")).ok;
  } catch {
    return false;
  }
})();

test(
  "real embeddings recall a re-flag of the same issue, not unrelated feedback",
  { skip: ollamaUp ? false : "Ollama not running", timeout: 60_000 },
  async () => {
    const k = new Knot(openDb(":memory:"), new OllamaEmbedder({ baseUrl: "http://localhost:11434/v1", model: "nomic-embed-text" }));
    await k.addIssue({ summary: "The order total does not update when the quantity changes", flow: "checkout" });

    const related = await k.recall("the total stays the same when I change the amount");
    assert.ok(related.length >= 1, "same-bug paraphrase should recall");
    assert.ok(related[0].score >= 0.65);

    const unrelated = await k.recall("the login page background color is too dark");
    assert.equal(unrelated.length, 0, "unrelated feedback should not recall");
    k.close();
  },
);

// M2: prompt construction + JSON extraction/validation. No network.
import type { ContextBundle } from "@heckle/shared";
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDraftingPrompt } from "../src/prompt.ts";
import { extractJson, parseDraft } from "../src/parse.ts";

function baseContext(): ContextBundle {
  return { url: "http://localhost:5173/", console: [], network: [], capturedAt: 0 };
}

const VALID = JSON.stringify({
  intent: "Recompute the order total when quantity changes",
  target: { flow: "checkout" },
  severity: "bug",
  repro: ["Open checkout", "Click +", "Total stays $20"],
  context: { consoleRefs: ["c1"], networkRefs: [] },
  fixHint: "Update total on quantity change",
});

test("extractJson strips <think> blocks", () => {
  assert.equal(extractJson(`<think>let me reason</think>\n{"a":1}`), `{"a":1}`);
});

test("extractJson strips markdown fences", () => {
  assert.equal(extractJson("```json\n{\"a\":1}\n```"), `{"a":1}`);
});

test("extractJson pulls the object out of surrounding prose", () => {
  assert.equal(extractJson(`Here is the draft: {"a":1}, hope that helps`), `{"a":1}`);
});

test("parseDraft accepts a valid draft", () => {
  const r = parseDraft(VALID);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.value.severity, "bug");
    assert.deepEqual(r.value.context.consoleRefs, ["c1"]);
  }
});

test("parseDraft rejects a bad severity", () => {
  const r = parseDraft(`{"intent":"x","severity":"nope","target":{},"repro":[],"context":{"consoleRefs":[],"networkRefs":[]}}`);
  assert.equal(r.ok, false);
});

test("parseDraft rejects non-JSON", () => {
  assert.equal(parseDraft("the model rambled with no json").ok, false);
});

test("buildDraftingPrompt includes transcript + console/network ids", () => {
  const context: ContextBundle = {
    url: "http://localhost:5173/checkout",
    flow: "checkout",
    console: [{ id: "c1", level: "error", args: ["TypeError: total is undefined"], ts: 1 }],
    network: [{ id: "n1", method: "POST", url: "/api/order", status: 500, ok: false, ts: 2 }],
    capturedAt: 1,
  };
  const { system, user } = buildDraftingPrompt({ transcript: "the place order button 500s", context, related: [] });
  assert.match(system, /JSON/);
  assert.match(user, /the place order button 500s/);
  assert.match(user, /\[c1\]/);
  assert.match(user, /\[n1\].*500/);
});

test("buildDraftingPrompt: design/UX changes are valid (not just bugs), no error required", () => {
  const { system } = buildDraftingPrompt({ transcript: "make it bigger", context: baseContext(), related: [] });
  assert.match(system, /design/i);
  assert.match(system, /polish/i);
  assert.match(system, /never require an error/i);
});

test("buildDraftingPrompt: pointed target + highlighted text are rendered for the model", () => {
  const context = baseContext();
  context.selection = { text: "Subscribe now", selector: "#cta .btn", label: '<button.btn> "Subscribe now"' };
  const { user } = buildDraftingPrompt({ transcript: "move this to the top", context, related: [] });
  assert.match(user, /Pointed at:.*button\.btn/);
  assert.match(user, /selector: #cta \.btn/);
  assert.match(user, /Highlighted text: "Subscribe now"/);
});

test("buildDraftingPrompt: insist adds the override so the model must not decline", () => {
  const { user } = buildDraftingPrompt({ transcript: "this is broken", context: baseContext(), related: [], insist: true });
  assert.match(user, /insists this/i);
  assert.match(user, /Do NOT return noIssue/);
});

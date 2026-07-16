import assert from "node:assert/strict";
import { test } from "node:test";
import { routeRequest } from "../src/fastlane/router.ts";

test("router sends obvious edits, questions, and behavior to the correct lanes", async () => {
  assert.equal((await routeRequest("call it Go Pro")).lane, "instant");
  assert.equal((await routeRequest("make this blue")).lane, "instant");
  assert.equal((await routeRequest("why is this total 20?")).lane, "question");
  assert.equal((await routeRequest("the total does not update")).lane, "agent");
});

test("ambiguous requests use the optional model label and recover to agent on model failure", async () => {
  assert.deepEqual(await routeRequest("improve this", async () => "question"), {
    lane: "question",
    stage: "model",
    reason: "ambiguous-model-label",
  });
  assert.equal((await routeRequest("improve this", async () => { throw new Error("offline"); })).lane, "agent");
});

test("at least sixteen of twenty obvious copy and style asks route instantly", async () => {
  const requests = [
    "call it Go Pro", "rename this to Checkout", "make this say Buy now", "this should read Continue",
    "change the text to Start", "set this to Done", "make this blue", "make it red", "make it darker",
    "make this bigger", "add more spacing", "hide this", "make this rounded", "make this bold",
    "change the color to green", "set this to #fff", "the button is broken", "why is this here?",
    "load more results", "the API returns 500",
  ];
  const decisions = await Promise.all(requests.map((request) => routeRequest(request)));
  assert.ok(decisions.filter((decision) => decision.lane === "instant").length >= 16);
});

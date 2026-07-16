import assert from "node:assert/strict";
import { test } from "node:test";
import { classify } from "../src/fastlane/classify.ts";

test("copy: explicit verbs extract the new text", () => {
  for (const [say, expected] of [
    ["call it Go Pro", "Go Pro"],
    ["make it say Go Pro", "Go Pro"],
    ["the button should say Go Pro", "Go Pro"],
    ["change the text to Go Pro", "Go Pro"],
    ["rename this to Checkout", "Checkout"],
    ["change it to Go Pro", "Go Pro"],
  ] as const) {
    const c = classify(say);
    assert.equal(c.lane, "copy", `lane for: ${say}`);
    assert.equal(c.newText, expected, `newText for: ${say}`);
  }
});

test("copy: quoted text and trailing punctuation are cleaned", () => {
  assert.equal(classify("call it 'Go Pro'.").newText, "Go Pro");
  assert.equal(classify('the label should say "Start free"').newText, "Start free");
  assert.equal(classify("change the text to Go Pro!").newText, "Go Pro");
});

test("copy: replace X with Y carries both sides", () => {
  const c = classify("replace Choose Pro with Go Pro");
  assert.equal(c.lane, "copy");
  assert.equal(c.oldText, "Choose Pro");
  assert.equal(c.newText, "Go Pro");
});

test("style: appearance values and keywords route to style", () => {
  for (const say of [
    "change it to blue",
    "make it blue",
    "make it bigger",
    "hide this",
    "make it bold",
    "too dark, lighten it",
    "change the background to red",
  ]) {
    assert.equal(classify(say).lane, "style", `lane for: ${say}`);
  }
});

test("behavioral: anything without a fast pattern falls to the agent lane", () => {
  for (const say of [
    "the total doesn't update when I change the quantity",
    "this button does nothing",
    "why is this loading twice",
    "the form submits but nothing happens",
  ]) {
    assert.equal(classify(say).lane, "behavioral", `lane for: ${say}`);
  }
});

test("copy: a rewrite request is not a blind swap, it defers to the agent", () => {
  // "to be more descriptive" is fuzzy, not a literal, so it must not become a copy edit.
  assert.notEqual(classify("change the text to be more descriptive").lane, "copy");
  assert.notEqual(classify("make it shorter").lane, "copy");
});

test('a copy target literally named a color still edits copy (explicit verb wins)', () => {
  const c = classify("call it Blue");
  assert.equal(c.lane, "copy");
  assert.equal(c.newText, "Blue");
});

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { applyLiteralEdit, revertEdit } from "../src/fastlane/apply.ts";
import { locateLiteral } from "../src/fastlane/locate.ts";

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "heckle-apply-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

test("applies a copy change to the pinned literal", async () => {
  const root = project({ "src/Btn.tsx": "export const B = () => <button>Choose Pro</button>;\n" });
  try {
    const loc = await locateLiteral(root, "Choose Pro");
    assert.equal(loc.confident, true);
    const res = await applyLiteralEdit(root, { match: loc.matches[0], oldText: "Choose Pro", newText: "Go Pro" });
    assert.equal(res.ok, true);
    const after = readFileSync(loc.matches[0].file, "utf8");
    assert.match(after, /<button>Go Pro<\/button>/);
    assert.doesNotMatch(after, /Choose Pro/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("replaces only the pinned occurrence, not every match", async () => {
  const root = project({ "src/Two.tsx": "<a>Save</a>\n<b>Save</b>\n" });
  try {
    const loc = await locateLiteral(root, "Save", { file: join(root, "src/Two.tsx"), line: 2 });
    const res = await applyLiteralEdit(root, { match: loc.matches[0], oldText: "Save", newText: "Store" });
    assert.equal(res.ok, true);
    assert.equal(readFileSync(join(root, "src/Two.tsx"), "utf8"), "<a>Save</a>\n<b>Store</b>\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses a stale match without writing", async () => {
  const root = project({ "src/S.tsx": "<button>Choose Pro</button>\n" });
  try {
    const match = { file: join(root, "src/S.tsx"), line: 1, column: 100, kind: "jsx-text" as const };
    const res = await applyLiteralEdit(root, { match, oldText: "Choose Pro", newText: "Go Pro" });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "stale");
    assert.equal(readFileSync(join(root, "src/S.tsx"), "utf8"), "<button>Choose Pro</button>\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses jsx-breaking replacement text", async () => {
  const root = project({ "src/J.tsx": "<span>Hello</span>\n" });
  try {
    const loc = await locateLiteral(root, "Hello");
    const res = await applyLiteralEdit(root, { match: loc.matches[0], oldText: "Hello", newText: "Hi <b>there" });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "jsx-breaking-char");
    assert.match(readFileSync(loc.matches[0].file, "utf8"), /Hello/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("allows an apostrophe inside a double-quoted string", async () => {
  const root = project({ "src/Q.tsx": 'const label = "Choose Pro";\n' });
  try {
    const loc = await locateLiteral(root, "Choose Pro");
    assert.equal(loc.matches[0].kind, "string");
    const res = await applyLiteralEdit(root, { match: loc.matches[0], oldText: "Choose Pro", newText: "Don't stop" });
    assert.equal(res.ok, true);
    assert.match(readFileSync(loc.matches[0].file, "utf8"), /"Don't stop"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses the surrounding quote char in a string", async () => {
  const root = project({ "src/Q2.tsx": 'const label = "Choose Pro";\n' });
  try {
    const loc = await locateLiteral(root, "Choose Pro");
    const res = await applyLiteralEdit(root, { match: loc.matches[0], oldText: "Choose Pro", newText: 'a"b' });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "quote-in-string");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses a path outside the project root", async () => {
  const root = project({ "src/A.tsx": "<b>Save</b>\n" });
  try {
    const match = { file: "/etc/hosts", line: 1, column: 1, kind: "jsx-text" as const };
    const res = await applyLiteralEdit(root, { match, oldText: "x", newText: "y" });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "outside-root");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dry run computes the edit without writing", async () => {
  const root = project({ "src/D.tsx": "<button>Choose Pro</button>\n" });
  try {
    const loc = await locateLiteral(root, "Choose Pro");
    const res = await applyLiteralEdit(
      root,
      { match: loc.matches[0], oldText: "Choose Pro", newText: "Go Pro" },
      { dryRun: true },
    );
    assert.equal(res.ok, true);
    assert.match(res.after ?? "", /Go Pro/);
    assert.equal(readFileSync(loc.matches[0].file, "utf8"), "<button>Choose Pro</button>\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("revert restores the original content", async () => {
  const root = project({ "src/R.tsx": "<button>Choose Pro</button>\n" });
  try {
    const loc = await locateLiteral(root, "Choose Pro");
    const res = await applyLiteralEdit(root, { match: loc.matches[0], oldText: "Choose Pro", newText: "Go Pro" });
    assert.equal(res.ok, true);
    assert.equal(await revertEdit(root, res.file, res.before ?? ""), true);
    assert.equal(readFileSync(loc.matches[0].file, "utf8"), "<button>Choose Pro</button>\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

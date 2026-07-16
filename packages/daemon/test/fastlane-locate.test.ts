import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { locateLiteral } from "../src/fastlane/locate.ts";

// Build a throwaway project tree and return its root.
function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "heckle-locate-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

test("locates a unique copy literal via grep", async () => {
  const root = project({
    "src/PricingCard.tsx": "export const C = () => <button>Choose Pro</button>;\n",
    "src/Other.tsx": "export const O = () => <div>Hello</div>;\n",
  });
  try {
    const res = await locateLiteral(root, "Choose Pro");
    assert.equal(res.via, "grep");
    assert.equal(res.confident, true);
    assert.equal(res.matches.length, 1);
    assert.match(res.matches[0].file, /PricingCard\.tsx$/);
    assert.equal(res.matches[0].line, 1);
    assert.equal(res.matches[0].kind, "jsx-text");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a file+line hint pins the match when the literal repeats", async () => {
  const root = project({
    "src/A.tsx": "<button>Save</button>\n",
    "src/B.tsx": "<a>Save</a>\n<span>Save</span>\n",
  });
  try {
    const res = await locateLiteral(root, "Save", { file: join(root, "src/B.tsx"), line: 2 });
    assert.equal(res.via, "source-hint");
    assert.equal(res.confident, true);
    assert.match(res.matches[0].file, /B\.tsx$/);
    assert.equal(res.matches[0].line, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ambiguous grep is reported, not guessed", async () => {
  const root = project({
    "src/A.tsx": "<button>Save</button>\n",
    "src/B.tsx": "<a>Save</a>\n",
  });
  try {
    const res = await locateLiteral(root, "Save");
    assert.equal(res.confident, false);
    assert.ok(res.matches.length >= 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a hint outside the project root is refused, falls back to grep", async () => {
  const root = project({ "src/A.tsx": "<button>Save</button>\n" });
  try {
    const res = await locateLiteral(root, "Save", { file: "/etc/passwd", line: 1 });
    assert.notEqual(res.via, "source-hint");
    assert.equal(res.matches.every((m) => m.file.startsWith(root)), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("node_modules is not searched", async () => {
  const root = project({
    "src/A.tsx": "<button>Widget</button>\n",
    "node_modules/pkg/index.js": "export const s = 'Widget';\n",
  });
  try {
    const res = await locateLiteral(root, "Widget");
    assert.equal(res.confident, true);
    assert.equal(res.matches.length, 1);
    assert.match(res.matches[0].file, /src\/A\.tsx$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing literal returns none", async () => {
  const root = project({ "src/A.tsx": "<div>Hello</div>\n" });
  try {
    const res = await locateLiteral(root, "Nonexistent Copy");
    assert.equal(res.via, "none");
    assert.equal(res.confident, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

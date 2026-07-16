import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { applyAstEdit, type AstEditOperation } from "../src/fastlane/ast-edit.ts";
import { UndoStore } from "../src/fastlane/undo.ts";

async function apply(source: string, line: number, operation: AstEditOperation) {
  const root = mkdtempSync(resolve(tmpdir(), "heckle-ast-"));
  const file = resolve(root, "View.tsx");
  writeFileSync(file, source);
  const result = await applyAstEdit(root, { file, line, operation });
  return { root, file, result, content: () => readFileSync(file, "utf8") };
}

test("AST instant edits cover text, Tailwind, style, visibility, and static sibling order", async () => {
  const cases: Array<{ source: string; line: number; operation: AstEditOperation; expected: RegExp }> = [
    { source: `const x = <button>Old copy</button>;\n`, line: 1, operation: { kind: "text", oldValue: "Old copy", newValue: "New copy" }, expected: />New copy</ },
    { source: `const x = <button className="bg-red-500 p-2">Go</button>;\n`, line: 1, operation: { kind: "class-token", oldValue: "bg-red-500", newValue: "bg-blue-500" }, expected: /bg-blue-500 p-2/ },
    { source: `const x = <button style={{ color: "red", padding: 4 }}>Go</button>;\n`, line: 1, operation: { kind: "style", property: "color", newValue: "blue" }, expected: /color: "blue"/ },
    { source: `const x = <button>Go</button>;\n`, line: 1, operation: { kind: "visibility", hidden: true }, expected: /button hidden/ },
    { source: `const x = <div><span>A</span><span>B</span></div>;\n`, line: 1, operation: { kind: "reorder", fromIndex: 1, toIndex: 0 }, expected: /<span>B<\/span><span>A<\/span>/ },
  ];
  for (const item of cases) {
    const value = await apply(item.source, item.line, item.operation);
    try {
      assert.equal(value.result.ok, true, value.result.reason);
      assert.match(value.content(), item.expected);
      assert.ok(value.result.durationMs < 800, `${item.operation.kind}: ${value.result.durationMs}ms`);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  }
});

test("AST instant edits refuse non-literal class and style expressions", async () => {
  for (const source of [`const x = <div className={classes}>X</div>;\n`, `const x = <div style={styles}>X</div>;\n`]) {
    const operation: AstEditOperation = source.includes("className")
      ? { kind: "class-token", oldValue: "red", newValue: "blue" }
      : { kind: "style", property: "color", newValue: "blue" };
    const value = await apply(source, 1, operation);
    try {
      assert.equal(value.result.ok, false);
      assert.equal(value.content(), source);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  }
});

test("undo restores only when the file still matches the instant edit", async () => {
  const value = await apply(`const x = <button>Old</button>;\n`, 1, { kind: "text", oldValue: "Old", newValue: "New" });
  try {
    assert.ok(value.result.before && value.result.after);
    const store = new UndoStore(value.root);
    store.push({ id: "fix_test", file: "View.tsx", before: value.result.before!, after: value.result.after!, createdAt: "now" });
    store.undo();
    assert.match(value.content(), />Old</);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

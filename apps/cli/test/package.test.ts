import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));

test("the npm artifact contains runtime files only", () => {
  const raw = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
  });
  const report = JSON.parse(raw) as Array<{ files: Array<{ path: string }> }>;
  const files = new Set(report[0].files.map((f) => f.path));

  for (const required of [
    "package.json",
    "README.md",
    "LICENSE",
    "dist/apps/cli/bin/heckle.js",
    "dist/apps/cli/src/cli.js",
    "dist/apps/cli/src/readiness.js",
    "dist/packages/daemon/src/main.js",
    "dist/packages/daemon/src/server.js",
    "dist/packages/capture/src/loader.js",
    "dist/packages/capture/src/browser/index.js",
    "dist/packages/capture/src/source-loader.cjs",
    "dist/packages/replay/src/engine.js",
    "dist/packages/replay/src/store.js",
    "dist/packages/mcp/src/server.js",
  ]) {
    assert.ok(files.has(required), `artifact includes ${required}`);
  }

  for (const path of files) {
    assert.doesNotMatch(path, /(^|\/)(test|docs|examples|node_modules|\.heckle)(\/|$)/);
    assert.doesNotMatch(path, /(^|\/)(\.env|heckle\.config\.ts|package-lock\.json)$/);
  }
});

test("published runtime source has no workspace package imports", () => {
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
    name: string;
    version: string;
    private?: boolean;
    bin?: Record<string, string>;
  };
  assert.equal(manifest.name, "heckle-dev");
  assert.equal(manifest.version, "0.0.1");
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.bin?.heckle, "dist/apps/cli/bin/heckle.js");

  const raw = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
  });
  const report = JSON.parse(raw) as Array<{ files: Array<{ path: string }> }>;
  for (const file of report[0].files) {
    if (!/\.(ts|js)$/.test(file.path)) continue;
    const source = readFileSync(resolve(root, file.path), "utf8");
    assert.doesNotMatch(source, /from\s+["']@heckle\//, `${file.path} uses a workspace import`);
  }
});

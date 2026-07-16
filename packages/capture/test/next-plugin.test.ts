import assert from "node:assert/strict";
import { test } from "node:test";
import { withHeckle } from "../src/next-plugin.ts";

test("Next plugin adds the source loader only in development", () => {
  const plugin = withHeckle();
  const development = plugin.webpack?.({ module: { rules: [] } }, { dev: true }) as { module: { rules: Array<{ enforce?: string; use?: Array<{ loader: string }> }> } };
  assert.equal(development.module.rules[0].enforce, "pre");
  assert.match(development.module.rules[0].use?.[0].loader ?? "", /source-loader\.cjs$/);
  const production = plugin.webpack?.({ module: { rules: [] } }, { dev: false }) as { module: { rules: unknown[] } };
  assert.equal(production.module.rules.length, 0);
});

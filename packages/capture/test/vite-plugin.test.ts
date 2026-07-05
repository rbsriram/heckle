// M6: the ambient-attach Vite plugin shape.
import assert from "node:assert/strict";
import { test } from "node:test";
import { heckle } from "../src/vite-plugin.ts";

test("heckle() vite plugin injects the loader script into the body, dev only", () => {
  const p = heckle({ daemonUrl: "http://127.0.0.1:9999" });
  assert.equal(p.name, "heckle");
  assert.equal(p.apply, "serve");

  const out = p.transformIndexHtml("<html><body></body></html>");
  assert.equal(out.tags.length, 1);
  assert.equal(out.tags[0].tag, "script");
  assert.equal(out.tags[0].attrs?.src, "http://127.0.0.1:9999/heckle.js");
  assert.equal(out.tags[0].injectTo, "body");
});

test("heckle() falls back to HECKLE_DAEMON_URL / default", () => {
  const p = heckle();
  const out = p.transformIndexHtml("<html></html>");
  assert.match(out.tags[0].attrs?.src ?? "", /\/heckle\.js$/);
});

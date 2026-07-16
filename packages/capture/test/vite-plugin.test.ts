// M6: the ambient-attach Vite plugin shape.
import assert from "node:assert/strict";
import { test } from "node:test";
import { heckle, injectSourceLocations } from "../src/vite-plugin.ts";

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

test("Vite transform maps at least 95 percent of rendered JSX elements to source", () => {
  const source = `export const App = () => <main><h1>Title</h1><button>Go</button><img src="x" /><section><p>Body</p></section></main>;`;
  const output = injectSourceLocations(source, "/project/src/App.tsx", "/project");
  const rendered = (output.match(/<(?:main|h1|button|img|section|p)\b/g) ?? []).length;
  const mapped = (output.match(/data-heckle-src=/g) ?? []).length;
  assert.equal(rendered, 6);
  assert.ok(mapped / rendered >= 0.95, `${mapped}/${rendered}`);
  assert.match(output, /src\/App\.tsx:1:/);
});

test("heckle() falls back to HECKLE_DAEMON_URL / default", () => {
  const p = heckle();
  const out = p.transformIndexHtml("<html></html>");
  assert.match(out.tags[0].attrs?.src ?? "", /\/heckle\.js$/);
});

// The injecting proxy: HTML gets the widget spliced in; everything else passes through.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, test } from "node:test";
import { injectSnippet, startInjectingProxy } from "../src/proxy.ts";

test("injectSnippet inserts once, before </body>, and is idempotent on /heckle.js", () => {
  const snip = `<script src="http://x/heckle.js"></script>`;
  assert.equal(injectSnippet("<html><body>hi</body></html>", snip), `<html><body>hi${snip}</body></html>`);
  assert.equal(injectSnippet("<head></head>", snip), `<head>${snip}</head>`);
  // already attached -> unchanged
  const withScript = `<body><script src="/heckle.js"></script></body>`;
  assert.equal(injectSnippet(withScript, snip), withScript);
});

test("proxy injects into HTML responses and passes other content through", async () => {
  const upstream: Server = createServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body>app</body></html>");
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    }
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upstreamPort = (upstream.address() as { port: number }).port;

  const proxy = startInjectingProxy({
    listenPort: 0,
    targetHost: "127.0.0.1",
    targetPort: upstreamPort,
    snippet: `<script src="http://127.0.0.1:4317/heckle.js"></script>`,
  });
  await new Promise<void>((r) => proxy.on("listening", () => r()));
  const proxyPort = (proxy.address() as { port: number }).port;

  after(() => {
    proxy.close();
    upstream.close();
  });

  const html = await (await fetch(`http://127.0.0.1:${proxyPort}/`)).text();
  assert.match(html, /heckle\.js/);
  assert.match(html, /app/);

  const json = await (await fetch(`http://127.0.0.1:${proxyPort}/api`)).text();
  assert.equal(json, '{"ok":true}'); // untouched
});

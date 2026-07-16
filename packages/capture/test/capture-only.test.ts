import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { test } from "node:test";
import { chromium } from "playwright";

const script = readFileSync(new URL("../src/capture-only.js", import.meta.url), "utf8");

test("a non-technical staging user exports a task-only Heckle from the script tag", { timeout: 15_000 }, async () => {
  const server = createServer((request, response) => {
    if (request.url === "/h.js") {
      response.writeHead(200, { "content-type": "application/javascript" });
      response.end(script);
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><button id="order">Place order</button><script src="/h.js" data-project="sample" data-reporter="reporter-a"></script>`);
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ acceptDownloads: true });
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.click("#order");
    const root = page.locator("#heckle-capture-only");
    await root.locator("button#launch").click();
    await root.locator("textarea#note").fill("The order button does nothing");
    const downloadPromise = page.waitForEvent("download");
    await root.locator("button[type=submit]").click();
    const download = await downloadPromise;
    const path = await download.path();
    if (!path) throw new Error("capture did not download");
    const payload = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    assert.equal(payload.schema, "heckle-capture@1");
    assert.equal(payload.reporter, "reporter-a");
    assert.equal(payload.intent, "The order button does nothing");
    assert.deepEqual(payload.repro, ["Click Place order"]);
    assert.equal("dom" in payload, false);
    assert.equal("network_bodies" in payload, false);
  } finally {
    await browser.close();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import type { HeckleConfig } from "../../shared/src/index.ts";
import type { ModelProvider } from "../../providers/src/index.ts";
import { startDaemon } from "../../daemon/src/server.ts";
import { startInjectingProxy } from "../../daemon/src/proxy.ts";
import { ReplayEngine, ReproStore, VerificationEngine, selectRegressionRepros } from "../src/index.ts";

function listen(server: Server): Promise<number> {
  return new Promise((resolveListen) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server did not bind");
      resolveListen(address.port);
    });
  });
}

function freePort(): Promise<number> {
  const server = createServer();
  return listen(server).then((port) => new Promise((resolvePort) => server.close(() => resolvePort(port))));
}

function runCli(cwd: string, args: string[]): Promise<{ code: number; output: string }> {
  const cli = resolve(import.meta.dirname, "../../../apps/cli/bin/heckle.ts");
  return new Promise((resolveRun) => {
    execFile(process.execPath, [cli, ...args], { cwd }, (error, stdout, stderr) => {
      resolveRun({ code: typeof error?.code === "number" ? error.code : 0, output: `${stdout}${stderr}` });
    });
  });
}

test("ten browser heckles pass capture and fix verification, then detect a reintroduced regression", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(resolve(tmpdir(), "heckle-p1-e2e-"));
  let brokenResult: number | undefined;
  const app = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    const controls = Array.from({ length: 10 }, (_, index) => {
      const number = index + 1;
      return `<button data-testid="action-${number}">Run ${number}</button><span id="result-${number}">waiting</span>`;
    }).join("");
    res.end(`<!doctype html>${controls}<script>
      localStorage.setItem('authToken', 'fake-token');
      localStorage.setItem('theme', 'dark');
      for (let number = 1; number <= 10; number++) {
        document.querySelector('[data-testid="action-' + number + '"]').onclick = () => {
          document.querySelector('#result-' + number).textContent = number === ${brokenResult ?? "undefined"} ? 'broken' : 'done';
        };
      }
    </script>`);
  });
  const appPort = await listen(app);
  const daemonPort = await freePort();
  const proxyPort = await freePort();
  const provider: ModelProvider = {
    name: "p1-e2e",
    async draft(request) {
      const number = Number(request.transcript.match(/result (\d+)/)?.[1] ?? "1");
      return {
        intent: `Keep result ${number} visible`,
        target: { selector: `#result-${number}` },
        severity: "bug",
        repro: [`Click action ${number}`, `Check result ${number}`],
        context: { consoleRefs: [], networkRefs: [] },
        assertions: [{ type: "text_equals", target: { css: `#result-${number}` }, expected: "done" }],
      };
    },
  };
  const config: HeckleConfig = {
    drafting: { provider: "ollama", model: "test", baseUrl: "http://localhost:11434/v1" },
    voice: { provider: "webspeech" },
    delivery: { order: ["file-inbox"] },
    agent: "none",
    privacy: { localOnly: true },
  };
  const daemon = await startDaemon({
    port: daemonPort,
    config,
    projectRoot: root,
    provider,
    memory: null,
    metrics: null,
    verification: null,
  });
  const proxy = startInjectingProxy({
    listenPort: proxyPort,
    targetHost: "127.0.0.1",
    targetPort: appPort,
    snippet: `<script src="http://127.0.0.1:${daemonPort}/heckle.js"></script>`,
  });
  await new Promise<void>((resolveListen) => proxy.on("listening", resolveListen));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const store = new ReproStore(root);
    for (let number = 1; number <= 10; number++) {
      await page.goto(`http://127.0.0.1:${proxyPort}/`);
      await page.getByTestId(`action-${number}`).click();
      await page.locator("#heckle-root").locator("button.launcher").click();
      await page.locator("#heckle-root").locator("textarea#ta").fill(`result ${number} should stay done`);
      await page.locator("#heckle-root").locator("button#send").click();
      await page.locator("#heckle-root").locator("[data-ship]").click();
      for (let attempt = 0; attempt < 50 && store.list().length < number; attempt++) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
      assert.equal(store.list().length, number);
    }
    const artifacts = store.list();
    let passing = 0;
    for (const artifact of artifacts) {
      assert.equal(artifact.state_seed.localStorage.authToken, undefined);
      assert.equal(artifact.state_seed.localStorage.theme, "dark");
      assert.ok(artifact.actions.some((action) => action.type === "click" && action.target.testid?.startsWith("action-")));
      const gate = await new ReplayEngine(store).gate(artifact, {
        runs: 3,
        origin: `http://127.0.0.1:${proxyPort}`,
      });
      if (gate.stable && gate.results.every((result) => result.passed)) passing += 1;
      assert.ok(gate.results.every((result) => result.durationMs < 10_000));
      const verification = await new VerificationEngine(store).verify(artifact, {
        origin: `http://127.0.0.1:${proxyPort}`,
      });
      assert.equal(verification.status, "fixed");
    }
    assert.ok(passing / artifacts.length >= 0.8, `${passing}/${artifacts.length} repros passed the gate`);
    assert.equal(selectRegressionRepros(store.list()).length, 10);
    brokenResult = 1;
    const resultOne = store.list().find((artifact) => artifact.assertions.some(
      (assertion) => assertion.type === "text_equals" && assertion.target.css === "#result-1",
    ));
    assert.ok(resultOne);
    const regression = await new ReplayEngine(store).run(resultOne, { origin: `http://127.0.0.1:${proxyPort}` });
    assert.equal(regression.passed, false);
    const ci = await runCli(root, ["test", "--url", `http://127.0.0.1:${proxyPort}`]);
    assert.equal(ci.code, 1);
    assert.match(ci.output, /regressions: 9\/10 passed/);
  } finally {
    await browser.close();
    await daemon.close();
    await new Promise<void>((resolveClose) => proxy.close(() => resolveClose()));
    await new Promise<void>((resolveClose) => app.close(() => resolveClose()));
    rmSync(root, { recursive: true, force: true });
  }
});

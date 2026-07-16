import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import type { ContextBundle, Feedback, ReproArtifact } from "../../shared/src/index.ts";
import { createReproArtifact, ReplayEngine, ReproStore } from "../src/index.ts";

const root = mkdtempSync(resolve(tmpdir(), "heckle-replay-"));
test.after(() => rmSync(root, { recursive: true, force: true }));

test("ReproStore saves versioned artifacts and fixture bodies", () => {
  const store = new ReproStore(root);
  const bodyRef = store.saveFixture("fixture.json", "{\"ok\":true}", "application/json");
  assert.deepEqual(store.loadFixture(bodyRef), { body: "{\"ok\":true}", contentType: "application/json" });
  const artifact: ReproArtifact = {
    version: 1,
    id: "hkl_test",
    issue_id: "iss_test",
    created_at: new Date().toISOString(),
    origin: "http://localhost:3000",
    route: "/",
    viewport: { width: 1280, height: 720 },
    state_seed: { localStorage: {}, sessionStorage: {}, cookies: [] },
    actions: [{ type: "goto", url: "/", ts: 1 }],
    network_fixtures: [],
    assertions: [],
    utterance: "test",
    determinism: { runs: 0, pass_rate: 0, quarantined: false },
  };
  const path = store.save(artifact);
  assert.ok(existsSync(path));
  assert.equal(store.load("hkl_test")?.version, 1);
  assert.equal(store.list().length, 1);
});

test("createReproArtifact trims from the last route and writes network fixtures", () => {
  const feedback: Feedback = {
    id: "fb_test",
    intent: "total should be 40",
    target: { selector: "#total" },
    severity: "bug",
    repro: [],
    context: { consoleRefs: [], networkRefs: [] },
    assertions: [{ type: "text_equals", target: { css: "#total" }, expected: "40" }],
  };
  const context: ContextBundle = {
    url: "http://localhost:3000/checkout",
    console: [],
    network: [{
      id: "n1",
      method: "POST",
      url: "http://localhost:3000/api/cart",
      status: 200,
      ok: true,
      responseBody: "{\"total\":40}",
      ts: 2,
    }],
    actions: [
      { type: "goto", url: "/old", ts: 1 },
      { type: "click", target: { css: "#old" }, ts: 2 },
      { type: "goto", url: "/checkout", ts: 3 },
      { type: "click", target: { testid: "increment", css: "#inc" }, ts: 4 },
    ],
    viewport: { width: 1440, height: 900 },
    stateSeed: { localStorage: { cart: "1" }, sessionStorage: {}, cookies: [] },
    capturedAt: 5,
  };
  const artifact = createReproArtifact(root, feedback, context, "iss_test", "total is wrong");
  assert.equal(artifact.actions.length, 2);
  assert.equal(artifact.actions[0].type, "goto");
  assert.equal(artifact.network_fixtures.length, 1);
  assert.equal(artifact.assertions[0].type, "text_equals");
  assert.deepEqual(artifact.surfaces, {
    routes: ["/checkout"],
    files: [],
    elements: ["testid:increment", "css:#total"],
  });
  const fixturePath = resolve(root, ".heckle", "repros", artifact.network_fixtures[0].body_ref);
  assert.ok(readFileSync(fixturePath, "utf8").includes("total"));
});

test("ReplayEngine uses recorded fixtures by default and live network on request", async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": req.url === "/api/value" ? "text/plain" : "text/html" });
    if (req.url === "/api/value") res.end("live");
    else res.end(`<!doctype html><span id="value">loading</span><script>
      fetch('/api/value').then((r) => r.text()).then((text) => document.querySelector('#value').textContent = text);
    </script>`);
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const store = new ReproStore(root);
  const bodyRef = store.saveFixture("network.json", "recorded", "text/plain");
  const artifact: ReproArtifact = {
    version: 1,
    id: "hkl_fixture",
    issue_id: "iss_fixture",
    created_at: new Date().toISOString(),
    origin: `http://127.0.0.1:${address.port}`,
    route: "/",
    viewport: { width: 800, height: 600 },
    state_seed: { localStorage: {}, sessionStorage: {}, cookies: [] },
    actions: [{ type: "goto", url: "/", ts: 1 }],
    network_fixtures: [{
      match: "GET /api/value",
      method: "GET",
      status: 200,
      body_ref: bodyRef,
      recorded_at: new Date().toISOString(),
    }],
    assertions: [{ type: "text_equals", target: { css: "#value" }, expected: "recorded" }],
    utterance: "fixture test",
    determinism: { runs: 0, pass_rate: 0, quarantined: false },
  };
  try {
    const engine = new ReplayEngine(store);
    const fixtureResult = await engine.run(artifact);
    assert.equal(fixtureResult.passed, true);
    const liveResult = await engine.run(artifact, { live: true });
    assert.equal(liveResult.passed, false);
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});

test("ReplayEngine executes actions, assertions, and the 3-run determinism gate", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><button data-testid="increment">+</button><span id="total">1</span><script>
      document.querySelector('[data-testid="increment"]').onclick = () => {
        document.querySelector('#total').textContent = '2';
      };
    </script>`);
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const artifact: ReproArtifact = {
    version: 1,
    id: "hkl_browser",
    issue_id: "iss_browser",
    created_at: new Date().toISOString(),
    origin: `http://127.0.0.1:${address.port}`,
    route: "/",
    viewport: { width: 800, height: 600 },
    state_seed: { localStorage: {}, sessionStorage: {}, cookies: [] },
    actions: [
      { type: "goto", url: "/", ts: 1 },
      { type: "click", target: { testid: "increment", css: "button" }, ts: 2 },
    ],
    network_fixtures: [],
    assertions: [{ type: "text_equals", target: { css: "#total" }, expected: "2" }],
    utterance: "increment should update total",
    determinism: { runs: 0, pass_rate: 0, quarantined: false },
  };
  const store = new ReproStore(root);
  store.save(artifact);
  try {
    const gate = await new ReplayEngine(store).gate(artifact, { runs: 3 });
    assert.equal(gate.stable, true);
    assert.equal(gate.results.every((result) => result.passed), true);
    assert.equal(store.load(artifact.id)?.determinism.pass_rate, 1);
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});

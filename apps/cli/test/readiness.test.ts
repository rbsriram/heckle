import assert from "node:assert/strict";
import { createServer } from "node:net";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../../../packages/daemon/src/config.ts";
import type { SpawnFn, SpawnedChild } from "../../../packages/delivery/src/types.ts";
import {
  assertSupportedNode,
  inspectAgents,
  inspectOllama,
  isPortAvailable,
  runReadiness,
} from "../src/readiness.ts";

test("Node readiness requires version 24 or newer", () => {
  assert.doesNotThrow(() => assertSupportedNode("v24.0.0"));
  assert.throws(() => assertSupportedNode("v23.9.0"), /Node 24 or newer/);
  assert.throws(() => assertSupportedNode("invalid"), /Node 24 or newer/);
});

test("Ollama readiness identifies present and missing models", async () => {
  const ready = await inspectOllama(
    "http://localhost:11434/v1",
    "qwen3:14b",
    async () => new Response(JSON.stringify({ models: [{ name: "qwen3:14b" }] }), { status: 200 }),
  );
  assert.equal(ready.state, "ready");

  const missing = await inspectOllama(
    "http://localhost:11434/v1",
    "qwen3:14b",
    async () => new Response(JSON.stringify({ models: [{ name: "nomic-embed-text:latest" }] }), { status: 200 }),
  );
  assert.equal(missing.state, "missing-model");
});

test("Ollama readiness reports unreachable endpoints", async () => {
  const result = await inspectOllama("http://localhost:11434/v1", "qwen3:14b", async () => {
    throw new Error("connection refused");
  });
  assert.equal(result.state, "unreachable");
  assert.match(result.detail ?? "", /connection refused/);
});

test("agent readiness checks every supported binary", async () => {
  const seen: string[] = [];
  const agents = await inspectAgents(async (binary) => {
    seen.push(binary);
    return binary === "codex";
  });
  assert.deepEqual(seen, ["claude", "cursor-agent", "codex"]);
  assert.deepEqual(agents.map((a) => [a.agent, a.available]), [
    ["claude-code", false],
    ["cursor", false],
    ["codex", true],
  ]);
});

test("port readiness distinguishes free and occupied ports", async () => {
  assert.equal(await isPortAvailable(0), true);
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  assert.equal(await isPortAvailable(address.port), false);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("readiness fails with an install command when Chromium is missing", async () => {
  await assert.rejects(
    runReadiness(DEFAULT_CONFIG, {
      whichFn: async () => false,
      browserExecutablePath: () => "/missing/chromium",
      existsFn: () => false,
      log: () => {},
    }),
    /playwright@1\.61\.1 install chromium/,
  );
});

test("non-interactive readiness fails fast when the local model is missing", async () => {
  await assert.rejects(
    runReadiness(DEFAULT_CONFIG, {
      interactive: false,
      whichFn: async () => false,
      fetchFn: async () => new Response(JSON.stringify({ models: [] }), { status: 200 }),
      log: () => {},
    }),
    /ollama pull qwen3:14b/,
  );
});

test("an explicit model-check skip never contacts Ollama", async () => {
  let fetched = false;
  await runReadiness(DEFAULT_CONFIG, {
    skipModelCheck: true,
    whichFn: async () => false,
    fetchFn: async () => {
      fetched = true;
      throw new Error("must not fetch");
    },
    log: () => {},
  });
  assert.equal(fetched, false);
});

test("cloud readiness requires the provider key when the provider requires one", async () => {
  const config = {
    ...DEFAULT_CONFIG,
    drafting: { provider: "anthropic" as const, model: "test-model", baseUrl: "" },
    privacy: { localOnly: false },
  };
  await assert.rejects(
    runReadiness(config, { env: {}, whichFn: async () => false, log: () => {} }),
    /ANTHROPIC_API_KEY/,
  );
  await assert.doesNotReject(
    runReadiness(config, { env: { ANTHROPIC_API_KEY: "fake-test-key" }, whichFn: async () => false, log: () => {} }),
  );
});

test("readiness rejects a non-local provider under local-only mode", async () => {
  const config = {
    ...DEFAULT_CONFIG,
    drafting: { provider: "anthropic" as const, model: "test-model", baseUrl: "" },
    privacy: { localOnly: true },
  };
  await assert.rejects(
    runReadiness(config, { env: { ANTHROPIC_API_KEY: "fake-test-key" }, whichFn: async () => false, log: () => {} }),
    /local-only mode requires Ollama/,
  );
});

test("interactive readiness can pull a missing model", async () => {
  let inspections = 0;
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const child: SpawnedChild = {
    on(event, cb) {
      listeners.set(event, cb);
      if (event === "exit") queueMicrotask(() => cb(0));
      return child;
    },
  };
  const spawnFn: SpawnFn = (_cmd, _args, _opts) => child;
  await runReadiness(DEFAULT_CONFIG, {
    interactive: true,
    whichFn: async (binary) => binary === "ollama",
    fetchFn: async () => {
      inspections += 1;
      const models = inspections === 1 ? [] : [{ name: "qwen3:14b" }];
      return new Response(JSON.stringify({ models }), { status: 200 });
    },
    confirm: async () => true,
    spawnFn,
    log: () => {},
  });
  assert.equal(inspections, 2);
});

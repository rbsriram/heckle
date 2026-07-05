// M3: the orchestrator's approve gate firing end to end. A stub provider gives a canned
// draft (no Ollama needed); claude-code is forced unavailable so delivery lands on the
// file-inbox floor deterministically (no real `claude` spawned).
import type { HeckleConfig, ServerMessage } from "@heckle/shared";
import type { ModelProvider } from "@heckle/providers";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { Orchestrator } from "../src/orchestrator.ts";

const config: HeckleConfig = {
  drafting: { provider: "ollama", model: "qwen3:14b", baseUrl: "http://localhost:11434/v1" },
  voice: { provider: "local" },
  delivery: { order: ["claude-code", "file-inbox", "clipboard"] },
  agent: "claude-code",
  privacy: { localOnly: true },
};

const stubProvider: ModelProvider = {
  name: "stub",
  async draft() {
    return {
      intent: "Recompute the total when quantity changes",
      target: { flow: "checkout" },
      severity: "bug",
      repro: ["Open checkout", "Click +", "Total stays $20"],
      context: { consoleRefs: ["c1"], networkRefs: ["n1"] },
      fixHint: "Update total on qty change",
    };
  },
};

const context = {
  url: "http://localhost:5173/checkout",
  flow: "checkout",
  console: [{ id: "c1", level: "error" as const, args: ["TypeError: total is undefined"], ts: 1 }],
  network: [{ id: "n1", method: "POST", url: "/api/order", status: 500, ok: false, ts: 2 }],
  capturedAt: 3,
};

async function waitFor<T>(get: () => T | undefined, ms = 2000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("trigger -> draft -> approve -> delivered (inbox floor)", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "heckle-m3o-"));
  try {
    const orch = new Orchestrator(config, root, {
      provider: stubProvider,
      delivery: { whichFn: async () => false }, // no claude available -> file-inbox floor
      memory: null, // delivery test: skip recall
      metrics: null,
    });
    const replies: ServerMessage[] = [];
    const reply = (m: ServerMessage) => replies.push(m);

    orch.handleMessage(JSON.stringify({ type: "trigger", intentText: "the total is wrong", context }), reply);

    // ack is synchronous; draft resolves from the stub provider shortly after.
    assert.equal(replies[0]?.type, "ack");
    const draft = await waitFor(() => replies.find((r) => r.type === "draft"));
    if (draft.type !== "draft") throw new Error("not a draft");
    const feedbackId = draft.feedback.id;
    assert.equal(draft.feedback.severity, "bug");
    assert.deepEqual(draft.feedback.context.networkRefs, ["n1"]);

    orch.handleMessage(JSON.stringify({ type: "approve", feedbackId }), reply);
    const delivered = await waitFor(() => replies.find((r) => r.type === "delivered"));
    if (delivered.type !== "delivered") throw new Error("not delivered");

    assert.equal(delivered.feedbackId, feedbackId);
    assert.ok(delivered.results.some((r) => r.adapter === "file-inbox" && r.ok), "inbox written");
    assert.ok(existsSync(resolve(root, ".heckle", "inbox.md")));
    assert.match(readFileSync(resolve(root, ".heckle", "inbox.md"), "utf8"), /Recompute the total/);

    // approving again -> no such pending draft
    replies.length = 0;
    orch.handleMessage(JSON.stringify({ type: "approve", feedbackId }), reply);
    const err = await waitFor(() => replies.find((r) => r.type === "error"));
    assert.match(err.type === "error" ? err.message : "", /no draft/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("history: a capture is recorded and its outcome tracks through drafting", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "heckle-hist-"));
  try {
    const orch = new Orchestrator(config, root, {
      provider: stubProvider,
      delivery: { whichFn: async () => false },
      memory: null,
      metrics: null,
    });
    const replies: ServerMessage[] = [];
    const reply = (m: ServerMessage) => replies.push(m);

    orch.handleMessage(JSON.stringify({ type: "trigger", intentText: "the total is wrong", context }), reply);
    const draft = await waitFor(() => replies.find((r) => r.type === "draft"));
    if (draft.type !== "draft") throw new Error("no draft");

    replies.length = 0;
    orch.handleMessage(JSON.stringify({ type: "history" }), reply);
    const hist = replies.find((r) => r.type === "history");
    if (hist?.type !== "history") throw new Error("no history reply");
    assert.equal(hist.captures.length, 1);
    assert.equal(hist.captures[0].transcript, "the total is wrong");
    assert.equal(hist.captures[0].outcome, "drafted");
    assert.equal(hist.captures[0].feedbackId, draft.feedback.id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fixStatus: background fix completion pushes status + marks the capture fixed", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "heckle-fix-"));
  try {
    let exitCb: ((code: number) => void) | null = null;
    const orch = new Orchestrator(config, root, {
      provider: stubProvider,
      delivery: {
        whichFn: async () => true, // claude-code "installed" -> dispatched
        spawnFn: ((_cmd: string, _args: readonly string[]) => ({
          on: (ev: string, cb: (code: number) => void) => {
            if (ev === "exit") exitCb = cb;
          },
          unref: () => {},
        })) as never,
      },
      memory: null,
      metrics: null,
    });
    const emitted: ServerMessage[] = [];
    orch.setEmitter((m) => emitted.push(m));
    const replies: ServerMessage[] = [];
    const reply = (m: ServerMessage) => replies.push(m);

    orch.handleMessage(JSON.stringify({ type: "trigger", intentText: "broken", context }), reply);
    const draft = await waitFor(() => replies.find((r) => r.type === "draft"));
    if (draft.type !== "draft") throw new Error("no draft");
    orch.handleMessage(JSON.stringify({ type: "approve", feedbackId: draft.feedback.id }), reply);
    await waitFor(() => replies.find((r) => r.type === "delivered"));

    // The background fix process exits successfully.
    assert.ok(exitCb, "an agent was spawned");
    exitCb!(0);

    const status = emitted.find((m) => m.type === "fixStatus");
    if (status?.type !== "fixStatus") throw new Error("no fixStatus emitted");
    assert.equal(status.ok, true);
    assert.equal(status.feedbackId, draft.feedback.id);

    // History reflects the landed fix.
    replies.length = 0;
    orch.handleMessage(JSON.stringify({ type: "history" }), reply);
    const hist = replies.find((r) => r.type === "history");
    if (hist?.type !== "history") throw new Error("no history");
    assert.equal(hist.captures[0].outcome, "fixed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setConfig persists the chosen model + key and rebuilds the provider live", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "heckle-cfg-"));
  const cfgHome = mkdtempSync(resolve(tmpdir(), "heckle-home-"));
  const prev = process.env.HECKLE_CONFIG_DIR;
  process.env.HECKLE_CONFIG_DIR = cfgHome; // keep the test off the real ~/.heckle
  try {
    const orch = new Orchestrator(config, root, { provider: stubProvider, delivery: { whichFn: async () => false }, memory: null, metrics: null });
    const replies: ServerMessage[] = [];
    const reply = (m: ServerMessage) => replies.push(m);

    orch.handleMessage(
      JSON.stringify({ type: "setConfig", provider: "deepseek", model: "deepseek-chat", apiKey: "sk-fake-000000000" }),
      reply,
    );
    const cfg = await waitFor(() => replies.find((r) => r.type === "config"));
    if (cfg.type !== "config") throw new Error("no config reply");
    assert.equal(cfg.drafting.provider, "deepseek");
    assert.equal(cfg.drafting.model, "deepseek-chat");
    assert.equal(cfg.error, undefined, "provider built (key present -> no error)");

    // Persisted to the user config layer (not the real home).
    const saved = JSON.parse(readFileSync(resolve(cfgHome, "config.json"), "utf8"));
    assert.equal(saved.drafting.provider, "deepseek");
    assert.equal(saved.privacy.localOnly, false, "cloud model turns local-only off");
    assert.equal(saved.env.DEEPSEEK_API_KEY, "sk-fake-000000000");

    // A hello now reports the new model to the gear.
    replies.length = 0;
    orch.handleMessage(JSON.stringify({ type: "hello", url: "http://x/" }), reply);
    const ready = replies.find((r) => r.type === "ready");
    assert.equal(ready?.type === "ready" ? ready.drafting?.model : "", "deepseek-chat");
  } finally {
    if (prev === undefined) delete process.env.HECKLE_CONFIG_DIR;
    else process.env.HECKLE_CONFIG_DIR = prev;
    rmSync(root, { recursive: true, force: true });
    rmSync(cfgHome, { recursive: true, force: true });
  }
});

test("setConfig accepts any OpenAI-compatible provider (base URL + <PROVIDER>_API_KEY)", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "heckle-any-"));
  const cfgHome = mkdtempSync(resolve(tmpdir(), "heckle-home-"));
  const prev = process.env.HECKLE_CONFIG_DIR;
  process.env.HECKLE_CONFIG_DIR = cfgHome;
  try {
    const orch = new Orchestrator(config, root, { provider: stubProvider, delivery: { whichFn: async () => false }, memory: null, metrics: null });
    const replies: ServerMessage[] = [];
    const reply = (m: ServerMessage) => replies.push(m);

    // A provider Heckle has no preset for: Groq, via its OpenAI-compatible endpoint.
    orch.handleMessage(
      JSON.stringify({ type: "setConfig", provider: "groq", model: "llama-3.3-70b", baseUrl: "https://api.groq.com/openai/v1", apiKey: "gsk-fake-000" }),
      reply,
    );
    const cfg = await waitFor(() => replies.find((r) => r.type === "config"));
    if (cfg.type !== "config") throw new Error("no config reply");
    assert.equal(cfg.drafting.provider, "groq");
    assert.equal(cfg.drafting.model, "llama-3.3-70b");
    assert.equal(cfg.error, undefined, "OpenAI-compatible provider builds with a key present");

    const saved = JSON.parse(readFileSync(resolve(cfgHome, "config.json"), "utf8"));
    assert.equal(saved.drafting.baseUrl, "https://api.groq.com/openai/v1");
    assert.equal(saved.env.GROQ_API_KEY, "gsk-fake-000", "key stored under <PROVIDER>_API_KEY");
    assert.equal(saved.privacy.localOnly, false);
  } finally {
    if (prev === undefined) delete process.env.HECKLE_CONFIG_DIR;
    else process.env.HECKLE_CONFIG_DIR = prev;
    rmSync(root, { recursive: true, force: true });
    rmSync(cfgHome, { recursive: true, force: true });
  }
});

test("approve with an edited instruction ships the edited intent, not the drafted one", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "heckle-edit-"));
  try {
    const inboxOnly: HeckleConfig = { ...config, delivery: { order: ["file-inbox", "clipboard"] } };
    const orch = new Orchestrator(inboxOnly, root, { provider: stubProvider, delivery: { whichFn: async () => false }, memory: null, metrics: null });
    const replies: ServerMessage[] = [];
    const reply = (m: ServerMessage) => replies.push(m);

    orch.handleMessage(JSON.stringify({ type: "trigger", intentText: "the total is wrong", context }), reply);
    const draft = await waitFor(() => replies.find((r) => r.type === "draft"));
    if (draft.type !== "draft") throw new Error("no draft");

    orch.handleMessage(
      JSON.stringify({ type: "approve", feedbackId: draft.feedback.id, edited: { intent: "Make the checkout total recompute live" } }),
      reply,
    );
    await waitFor(() => replies.find((r) => r.type === "delivered"));

    const inbox = readFileSync(resolve(root, ".heckle", "inbox.md"), "utf8");
    assert.match(inbox, /Make the checkout total recompute live/, "edited intent shipped");
    assert.doesNotMatch(inbox, /Recompute the total when quantity changes/, "original intent not used");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run: an inbox item is dispatched to the agent from the panel, then lands", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "heckle-run-"));
  try {
    let exitCb: ((code: number) => void) | null = null;
    // Inbox-only routing, so approve just files it (no agent) -> "in inbox".
    const inboxOnly: HeckleConfig = { ...config, delivery: { order: ["file-inbox", "clipboard"] } };
    const orch = new Orchestrator(inboxOnly, root, {
      provider: stubProvider,
      delivery: {
        whichFn: async () => true, // an agent IS installed, so "run" can dispatch to it
        spawnFn: ((_cmd: string, _args: readonly string[]) => ({
          on: (ev: string, cb: (code: number) => void) => {
            if (ev === "exit") exitCb = cb;
          },
          unref: () => {},
        })) as never,
      },
      memory: null,
      metrics: null,
    });
    const replies: ServerMessage[] = [];
    const reply = (m: ServerMessage) => replies.push(m);

    orch.handleMessage(JSON.stringify({ type: "trigger", intentText: "the total is wrong", context }), reply);
    const draft = await waitFor(() => replies.find((r) => r.type === "draft"));
    if (draft.type !== "draft") throw new Error("no draft");
    orch.handleMessage(JSON.stringify({ type: "approve", feedbackId: draft.feedback.id }), reply);
    await waitFor(() => replies.find((r) => r.type === "delivered"));

    // In the inbox: delivered, but no agent dispatched yet.
    replies.length = 0;
    orch.handleMessage(JSON.stringify({ type: "history" }), reply);
    let hist = replies.find((r) => r.type === "history");
    if (hist?.type !== "history") throw new Error("no history");
    assert.equal(hist.captures[0].outcome, "delivered");
    assert.equal(hist.captures[0].dispatchedAt, undefined, "no agent dispatched on approve");
    const captureId = hist.captures[0].id;

    // Run it from the panel -> dispatches to the agent (no terminal command needed).
    replies.length = 0;
    orch.handleMessage(JSON.stringify({ type: "run", captureId }), reply);
    await waitFor(() => replies.find((r) => r.type === "delivered"));
    assert.ok(exitCb, "the agent was spawned by run");
    exitCb!(0); // the fix lands

    replies.length = 0;
    orch.handleMessage(JSON.stringify({ type: "history" }), reply);
    hist = replies.find((r) => r.type === "history");
    if (hist?.type !== "history") throw new Error("no history 2");
    assert.equal(hist.captures[0].outcome, "fixed", "run -> agent -> landed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("remove: drops the row and strips the item from .heckle/inbox.md", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "heckle-rm-"));
  try {
    const inboxOnly: HeckleConfig = { ...config, delivery: { order: ["file-inbox", "clipboard"] } };
    const orch = new Orchestrator(inboxOnly, root, {
      provider: stubProvider,
      delivery: { whichFn: async () => false },
      memory: null,
      metrics: null,
    });
    const emitted: ServerMessage[] = [];
    orch.setEmitter((m) => emitted.push(m));
    const replies: ServerMessage[] = [];
    const reply = (m: ServerMessage) => replies.push(m);

    orch.handleMessage(JSON.stringify({ type: "trigger", intentText: "the total is wrong", context }), reply);
    const draft = await waitFor(() => replies.find((r) => r.type === "draft"));
    if (draft.type !== "draft") throw new Error("no draft");
    orch.handleMessage(JSON.stringify({ type: "approve", feedbackId: draft.feedback.id }), reply);
    await waitFor(() => replies.find((r) => r.type === "delivered"));

    const inboxPath = resolve(root, ".heckle", "inbox.md");
    assert.match(readFileSync(inboxPath, "utf8"), /Recompute the total/, "item is in the inbox");

    replies.length = 0;
    orch.handleMessage(JSON.stringify({ type: "history" }), reply);
    let hist = replies.find((r) => r.type === "history");
    if (hist?.type !== "history") throw new Error("no history");
    const captureId = hist.captures[0].id;

    // Remove it.
    orch.handleMessage(JSON.stringify({ type: "remove", captureId }), reply);
    assert.ok(emitted.some((m) => m.type === "removed" && m.captureId === captureId), "removed broadcast");

    // The row is gone and the inbox no longer carries the item.
    replies.length = 0;
    orch.handleMessage(JSON.stringify({ type: "history" }), reply);
    hist = replies.find((r) => r.type === "history");
    if (hist?.type !== "history") throw new Error("no history 2");
    assert.equal(hist.captures.length, 0, "capture removed");
    assert.doesNotMatch(readFileSync(inboxPath, "utf8"), /Recompute the total/, "inbox item stripped");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setDelivery reroutes dispatch to the chosen agent; ready reports the selection", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "heckle-sd-"));
  try {
    let spawned: { cmd: string; args: readonly string[] } | null = null;
    const orch = new Orchestrator(config, root, {
      provider: stubProvider,
      delivery: {
        whichFn: async () => true, // the chosen agent is "installed"
        spawnFn: ((cmd: string, args: readonly string[]) => {
          spawned = { cmd, args };
          return { on: () => {}, unref: () => {} };
        }) as never,
      },
      memory: null,
      metrics: null,
    });
    const replies: ServerMessage[] = [];
    const reply = (m: ServerMessage) => replies.push(m);

    // hello echoes the current routing (default = claude-code).
    orch.handleMessage(JSON.stringify({ type: "hello", url: "x" }), reply);
    const ready = replies.find((r) => r.type === "ready");
    assert.equal(ready?.type === "ready" ? ready.delivery?.agent : "", "claude-code");

    // The gear switches to Codex.
    orch.handleMessage(
      JSON.stringify({ type: "setDelivery", selection: { agent: "codex", session: "fresh", autonomy: "standard" } }),
      reply,
    );
    assert.equal(orch.deliverySelection.agent, "codex");

    // A fresh approve now dispatches to codex, not claude.
    orch.handleMessage(JSON.stringify({ type: "trigger", intentText: "broken", context }), reply);
    const draft = await waitFor(() => replies.find((r) => r.type === "draft"));
    if (draft.type !== "draft") throw new Error("no draft");
    orch.handleMessage(JSON.stringify({ type: "approve", feedbackId: draft.feedback.id }), reply);
    await waitFor(() => replies.find((r) => r.type === "delivered"));

    assert.ok(spawned, "an agent was spawned");
    assert.equal(spawned!.cmd, "codex");
    assert.equal(spawned!.args[0], "exec");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// M1 (daemon half): the widget <-> daemon WebSocket transport + trigger handling.
// Drives the hand-rolled WS server with Node's native WebSocket client (the same API
// the browser widget uses), so this validates framing against a real RFC6455 client.
import type { ContextBundle, ServerMessage } from "@heckle/shared";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { startDaemon, type DaemonHandle } from "../src/server.ts";

let daemon: DaemonHandle;
let projectRoot: string;

before(async () => {
  projectRoot = mkdtempSync(resolve(tmpdir(), "heckle-m1-"));
  // provider/memory null keeps M1 capture-only, no background drafting/recall.
  daemon = await startDaemon({ config: DEFAULT_CONFIG, port: 4401, projectRoot, provider: null, memory: null, metrics: null });
});

after(async () => {
  await daemon.close();
  rmSync(projectRoot, { recursive: true, force: true });
});

/** Open a connection, run an exchange, resolve with all server messages received. */
function exchange(send: (ws: WebSocket) => void, expectCount: number): Promise<ServerMessage[]> {
  return new Promise((resolvePromise, reject) => {
    const ws = new WebSocket(daemon.wsUrl);
    const got: ServerMessage[] = [];
    const timer = setTimeout(() => reject(new Error("timeout waiting for server messages")), 4000);
    ws.addEventListener("open", () => send(ws));
    ws.addEventListener("message", (ev) => {
      got.push(JSON.parse(ev.data as string) as ServerMessage);
      if (got.length >= expectCount) {
        clearTimeout(timer);
        ws.close();
        resolvePromise(got);
      }
    });
    ws.addEventListener("error", () => reject(new Error("ws error")));
  });
}

function bundle(over: Partial<ContextBundle> = {}): ContextBundle {
  return {
    url: "http://localhost:5173/checkout",
    flow: "checkout",
    console: [{ id: "c1", level: "error", args: ["TypeError: total is undefined"], ts: 1 }],
    network: [{ id: "n1", method: "POST", url: "/api/order", status: 500, ok: false, durationMs: 12, ts: 2 }],
    rrwebEvents: [{ type: 2 }, { type: 3 }],
    capturedAt: 1234567890,
    ...over,
  };
}

test("hello -> ready", async () => {
  const [msg] = await exchange((ws) => ws.send(JSON.stringify({ type: "hello", url: "x" })), 1);
  assert.equal(msg.type, "ready");
});

test("trigger -> ack with correct stats, stored + persisted", async () => {
  const [msg] = await exchange(
    (ws) => ws.send(JSON.stringify({ type: "trigger", intentText: "this total is not updating", context: bundle() })),
    1,
  );
  assert.equal(msg.type, "ack");
  if (msg.type !== "ack") return;
  assert.match(msg.triggerId, /^trg_/);
  assert.deepEqual(msg.stats, { console: 1, network: 1, rrweb: 2 });

  // stored in the orchestrator
  assert.equal(daemon.orchestrator.all[0].intentText, "this total is not updating");

  // persisted to <projectRoot>/.heckle/last-trigger.json
  const p = resolve(projectRoot, ".heckle", "last-trigger.json");
  assert.ok(existsSync(p), "last-trigger.json written");
  const saved = JSON.parse(readFileSync(p, "utf8"));
  assert.equal(saved.context.network[0].status, 500);
});

test("large payload (64-bit length frame) round-trips", async () => {
  // ~300KB of rrweb events forces the extended 64-bit payload length path.
  const rrwebEvents = Array.from({ length: 6000 }, (_, i) => ({ type: 3, t: i, d: "xxxxxxxxxxxxxxxxxxxx" }));
  const [msg] = await exchange(
    (ws) => ws.send(JSON.stringify({ type: "trigger", intentText: "big capture", context: bundle({ rrwebEvents }) })),
    1,
  );
  assert.equal(msg.type, "ack");
  if (msg.type !== "ack") return;
  assert.equal(msg.stats.rrweb, 6000);
});

test("invalid JSON -> error", async () => {
  const [msg] = await exchange((ws) => ws.send("not json {"), 1);
  assert.equal(msg.type, "error");
});

test("approve before M2 -> error (human gate not wired yet)", async () => {
  const [msg] = await exchange((ws) => ws.send(JSON.stringify({ type: "approve", feedbackId: "x" })), 1);
  assert.equal(msg.type, "error");
});

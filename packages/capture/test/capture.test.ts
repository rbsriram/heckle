// M1 (browser half): unit tests for the pure capture logic. These run in Node (no DOM),
// which is exactly why buffers.ts / context.ts keep zero DOM dependencies at import time.
import type { ConsoleEntry, NetworkEntry } from "@heckle/shared";
import assert from "node:assert/strict";
import { test } from "node:test";
import { installConsoleCapture, installFetchCapture, RingBuffer } from "../src/browser/buffers.ts";
import { assembleContext } from "../src/browser/context.ts";

test("RingBuffer evicts oldest beyond capacity; snapshot is a copy", () => {
  const rb = new RingBuffer<number>(3);
  for (const n of [1, 2, 3, 4, 5]) rb.push(n);
  assert.deepEqual(rb.snapshot(), [3, 4, 5]);
  assert.equal(rb.size, 3);
  const snap = rb.snapshot();
  snap.push(99);
  assert.equal(rb.size, 3, "snapshot must not mutate the buffer");
});

test("installConsoleCapture records entries and restores", () => {
  const buf = new RingBuffer<ConsoleEntry>(10);
  const calls: unknown[][] = [];
  const fake = {
    log: (...a: unknown[]) => calls.push(a),
    info: () => {},
    warn: () => {},
    error: (...a: unknown[]) => calls.push(a),
    debug: () => {},
  } as unknown as Console;

  const restore = installConsoleCapture(buf, fake);
  fake.log("hello", { a: 1 });
  fake.error(new Error("boom"));

  const entries = buf.snapshot();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].level, "log");
  assert.equal(entries[0].args[0], "hello");
  assert.equal(entries[0].args[1], JSON.stringify({ a: 1 }));
  assert.equal(entries[1].level, "error");
  assert.match(entries[1].args[0], /boom/);
  // original still called through (pass-through preserved)
  assert.equal(calls.length, 2);

  restore();
  fake.log("after restore");
  assert.equal(buf.size, 2, "no capture after restore");
});

test("installFetchCapture records status/ok/duration, passes response through, restores", async () => {
  const buf = new RingBuffer<NetworkEntry>(10);
  const root = {
    fetch: async (_input: RequestInfo | URL, _init?: RequestInit) =>
      ({ status: 500, ok: false }) as Response,
  };
  const restore = installFetchCapture(buf, root);

  const res = await root.fetch("/api/order", { method: "POST" });
  assert.equal(res.status, 500, "response passed through");

  const [entry] = buf.snapshot();
  assert.equal(entry.method, "POST");
  assert.equal(entry.url, "/api/order");
  assert.equal(entry.status, 500);
  assert.equal(entry.ok, false);
  assert.equal(typeof entry.durationMs, "number");

  restore();
  assert.equal(buf.size, 1);
});

test("installFetchCapture records failures (ok:false) and rethrows", async () => {
  const buf = new RingBuffer<NetworkEntry>(10);
  const root = {
    fetch: async () => {
      throw new Error("network down");
    },
  };
  installFetchCapture(buf, root);
  await assert.rejects(() => root.fetch("/x", { method: "GET" }), /network down/);
  const [entry] = buf.snapshot();
  assert.equal(entry.ok, false);
  assert.equal(entry.url, "/x");
});

test("installFetchCapture skips ignored URLs (Heckle's own daemon traffic)", async () => {
  const buf = new RingBuffer<NetworkEntry>(10);
  const root = { fetch: async () => ({ status: 200, ok: true }) as Response };
  installFetchCapture(buf, root, (url) => url.startsWith("http://127.0.0.1:4317"));
  await root.fetch("http://127.0.0.1:4317/config");
  await root.fetch("http://127.0.0.1:4317/transcribe");
  await root.fetch("http://localhost:5173/api/cart");
  const urls = buf.snapshot().map((e) => e.url);
  assert.deepEqual(urls, ["http://localhost:5173/api/cart"]);
});

test("assembleContext snapshots all buffers + url", () => {
  const buffers = {
    console: new RingBuffer<ConsoleEntry>(10),
    network: new RingBuffer<NetworkEntry>(10),
    rrweb: new RingBuffer<unknown>(10),
  };
  buffers.console.push({ id: "c1", level: "error", args: ["x"], ts: 1 });
  buffers.network.push({ id: "n1", method: "POST", url: "/api/order", status: 500, ok: false, ts: 2 });
  buffers.rrweb.push({ type: 3 });

  const ctx = assembleContext(buffers, { url: "http://localhost:5173/", flow: "checkout" });
  assert.equal(ctx.url, "http://localhost:5173/");
  assert.equal(ctx.flow, "checkout");
  assert.equal(ctx.console.length, 1);
  assert.equal(ctx.network[0].status, 500);
  assert.equal(ctx.rrwebEvents?.length, 1);
  assert.equal(typeof ctx.capturedAt, "number");
});

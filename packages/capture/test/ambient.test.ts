import assert from "node:assert/strict";
import { test } from "node:test";
import type { AmbientSignal, ContextBundle, ReproAction } from "../../shared/src/index.ts";
import { AmbientDetector, ambientFingerprint } from "../src/browser/ambient.ts";

const context: ContextBundle = {
  url: "http://localhost:3000/checkout",
  console: [],
  network: [],
  actions: [],
  capturedAt: 1,
};

function detector(options: { actions?: ReproAction[]; dismissed?: boolean; ignore?: string[] } = {}) {
  const signals: AmbientSignal[] = [];
  const value = new AmbientDetector({
    route: () => "/checkout",
    origin: () => "http://localhost:3000",
    context: () => structuredClone(context),
    actions: () => options.actions ?? [],
    ignore: options.ignore,
    dismissed: () => options.dismissed ?? false,
    emit: (signal) => signals.push(signal),
  });
  return { value, signals };
}

test("ambient fingerprints normalize variable values and include route plus top frame", () => {
  assert.equal(
    ambientFingerprint("Order 42 failed", "/checkout", "Error\n at submit (cart.ts:41:8)\n at click"),
    ambientFingerprint("Order 99 failed", "/checkout", "Error\n at submit (cart.ts:41:8)\n at other"),
  );
});

test("a fingerprint proposes after two occurrences with full context only on promotion", () => {
  const { value, signals } = detector();
  value.observeConsole({ id: "c1", level: "error", args: ["total failed 42"], ts: 1 });
  value.observeConsole({ id: "c2", level: "error", args: ["total failed 99"], ts: 2 });
  assert.equal(signals.length, 2);
  assert.equal(signals[0].context, undefined);
  assert.equal(signals[1].count, 2);
  assert.equal(signals[1].context?.url, context.url);
});

test("a click-triggered failed request proposes immediately with a trimmed action window", () => {
  const old: ReproAction = { type: "click", target: { testid: "old" }, ts: -40_000 };
  const route: ReproAction = { type: "goto", url: "/checkout", ts: 900 };
  const click: ReproAction = { type: "click", target: { testid: "submit" }, ts: 1_000 };
  const future: ReproAction = { type: "click", target: { testid: "future" }, ts: 2_000 };
  const { value, signals } = detector({ actions: [old, route, click, future], ignore: ["analytics"] });
  value.observeNetwork({ id: "n1", method: "POST", url: "/api/order", status: 500, ts: 1_500 });
  value.observeNetwork({ id: "n2", method: "POST", url: "/analytics", status: 500, ts: 1_600 });
  value.observeNetwork({ id: "n3", method: "GET", url: "https://example.com/fail", status: 500, ts: 1_700 });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].userVisible, true);
  assert.deepEqual(signals[0].context?.actions, [route, click]);
});

test("a simulated 30-minute session proposes five induced errors without duplicates", () => {
  const { value, signals } = detector();
  for (const [index, error] of ["cart", "payment", "address", "inventory", "receipt"].entries()) {
    value.observeException(`induced ${error} failure`, "Error\n at checkout (app.ts:10:2)", "exception", index * 300_000);
    value.observeException(`induced ${error} failure`, "Error\n at checkout (app.ts:10:2)", "exception", index * 300_000 + 1);
  }
  const proposals = signals.filter((signal) => signal.context);
  assert.equal(proposals.length, 5);
  assert.equal(new Set(proposals.map((signal) => signal.fingerprint)).size, 5);
});

test("dismissed fingerprints continue counting but never propose", () => {
  const { value, signals } = detector({ dismissed: true });
  value.observeException("render failed 1");
  value.observeException("render failed 2");
  assert.equal(signals[1].count, 2);
  assert.equal(signals[1].context, undefined);
});

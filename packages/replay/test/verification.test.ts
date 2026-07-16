import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import type { ReproArtifact } from "../../shared/src/index.ts";
import type { ReplayResult } from "../src/engine.ts";
import { ReproStore } from "../src/store.ts";
import { selectRegressionRepros, VerificationEngine } from "../src/verification.ts";

function artifact(id = "hkl_verify"): ReproArtifact {
  return {
    version: 1,
    id,
    issue_id: "iss_verify",
    created_at: new Date().toISOString(),
    origin: "http://localhost:3000",
    route: "/checkout",
    viewport: { width: 1280, height: 720 },
    state_seed: { localStorage: {}, sessionStorage: {}, cookies: [] },
    actions: [],
    network_fixtures: [],
    assertions: [{ type: "text_equals", target: { testid: "total" }, expected: "$40" }],
    utterance: "total should be $40",
    determinism: { runs: 3, pass_rate: 1, quarantined: false },
    surfaces: { routes: ["/checkout"], files: ["src/checkout.tsx"], elements: ["total"] },
  };
}

function replay(repro: ReproArtifact, passed: boolean, actual = "$40"): ReplayResult {
  return {
    reproId: repro.id,
    passed,
    durationMs: 10,
    assertions: [{ assertion: repro.assertions[0], passed, actual }],
    consoleErrors: [],
    failedRequests: [],
  };
}

test("verification promotes only after two passing replays", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "heckle-verify-pass-"));
  const store = new ReproStore(root);
  const repro = artifact();
  const runner = { run: async () => replay(repro, true) };
  const result = await new VerificationEngine(store, { runner }).verify(repro);
  assert.equal(result.status, "fixed");
  assert.equal(result.promoted, true);
  assert.deepEqual(result.results.map((item) => item.passed), [true, true]);
  assert.ok(store.load(repro.id)?.verification?.promoted_at);
  rmSync(root, { recursive: true, force: true });
});

test("verification reports observed deltas and does not promote a partial pass", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "heckle-verify-fail-"));
  const store = new ReproStore(root);
  const repro = artifact();
  let run = 0;
  const runner = { run: async () => replay(repro, ++run === 1, run === 1 ? "$40" : "$20") };
  const result = await new VerificationEngine(store, { runner }).verify(repro);
  assert.equal(result.status, "didnt_land");
  assert.equal(result.promoted, false);
  assert.deepEqual(result.delta, ["text_equals expected \"$40\", observed \"$20\""]);
  assert.equal(store.load(repro.id)?.verification?.promoted_at, undefined);
  rmSync(root, { recursive: true, force: true });
});

test("quarantined repros are reported without running", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "heckle-verify-quarantine-"));
  const store = new ReproStore(root);
  const repro = artifact();
  repro.determinism = { runs: 3, pass_rate: 2 / 3, quarantined: true };
  let runs = 0;
  const result = await new VerificationEngine(store, { runner: { run: async () => { runs++; return replay(repro, true); } } }).verify(repro);
  assert.equal(result.status, "quarantined");
  assert.equal(runs, 0);
  rmSync(root, { recursive: true, force: true });
});

test("changed selection uses source mappings and conservatively includes unmapped promoted repros", () => {
  const checkout = artifact("hkl_checkout");
  checkout.verification = { status: "fixed", runs: 2, outcomes: [true, true], last_run_at: "now", promoted_at: "now" };
  const profile = artifact("hkl_profile");
  profile.surfaces = { routes: ["/profile"], files: ["src/profile.tsx"], elements: [] };
  profile.verification = { status: "fixed", runs: 2, outcomes: [true, true], last_run_at: "now", promoted_at: "now" };
  const unmapped = artifact("hkl_unmapped");
  unmapped.surfaces = undefined;
  unmapped.verification = { status: "fixed", runs: 2, outcomes: [true, true], last_run_at: "now", promoted_at: "now" };
  const selected = selectRegressionRepros([checkout, profile, unmapped], ["src/checkout.tsx"]);
  assert.deepEqual(selected.map((item) => item.id), ["hkl_checkout", "hkl_unmapped"]);
});

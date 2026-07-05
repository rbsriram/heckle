// The gear's high-level delivery choice <-> the detailed per-agent config it maps to.
import type { HeckleConfig } from "@heckle/shared";
import assert from "node:assert/strict";
import { test } from "node:test";
import { selectionFromConfig, selectionToConfig } from "../src/delivery-selection.ts";

const base: HeckleConfig = {
  drafting: { provider: "ollama", model: "x", baseUrl: "y" },
  voice: { provider: "local" },
  delivery: {
    order: ["claude-code", "file-inbox", "clipboard"],
    claudeCode: { session: "persistent", permissionMode: "acceptEdits", allowedTools: ["Edit", "Bash(npm test:*)"] },
    cursor: { session: "persistent", force: true },
    codex: { session: "fresh", sandbox: "workspace-write", askForApproval: "never", skipGitRepoCheck: true },
  },
  agent: "claude-code",
  privacy: { localOnly: true },
};

test("selectionToConfig routes order + maps per-agent knobs", () => {
  const cursor = selectionToConfig(base, { agent: "cursor", session: "fresh", autonomy: "standard" });
  assert.deepEqual(cursor.delivery.order, ["cursor", "file-inbox", "clipboard"]);
  assert.equal(cursor.delivery.cursor?.session, "fresh");

  const codexFull = selectionToConfig(base, { agent: "codex", session: "persistent", autonomy: "full" });
  assert.deepEqual(codexFull.delivery.order, ["codex", "file-inbox", "clipboard"]);
  // The gear cannot grant codex an accumulating session: "continue" would resume the user's own
  // newest conversation (or error with none). It stays whatever the config says (here "fresh").
  assert.equal(codexFull.delivery.codex?.session, "fresh");
  assert.equal(codexFull.delivery.codex?.sandbox, "danger-full-access");
  assert.equal(codexFull.delivery.claudeCode?.permissionMode, "bypassPermissions"); // full autonomy

  const inbox = selectionToConfig(base, { agent: "inbox", session: "persistent", autonomy: "standard" });
  assert.deepEqual(inbox.delivery.order, ["file-inbox", "clipboard"]);
});

test("selectionToConfig preserves explicit user delivery config (order tail + per-agent knobs)", () => {
  // A deliberately clipboard-free order must stay clipboard-free after any gear touch.
  const noClip = { ...base, delivery: { ...base.delivery, order: ["claude-code", "file-inbox"] } } as HeckleConfig;
  assert.deepEqual(
    selectionToConfig(noClip, { agent: "codex", session: "fresh", autonomy: "standard" }).delivery.order,
    ["codex", "file-inbox"],
  );
  // The file-inbox floor survives even a custom order that dropped it.
  const bare = { ...base, delivery: { ...base.delivery, order: ["claude-code"] } } as HeckleConfig;
  assert.deepEqual(
    selectionToConfig(bare, { agent: "inbox", session: "persistent", autonomy: "standard" }).delivery.order,
    ["file-inbox"],
  );
  // Knobs the gear does not own are untouched: cursor force, codex askForApproval, codex continue.
  const custom = {
    ...base,
    delivery: {
      ...base.delivery,
      cursor: { session: "persistent", force: false },
      codex: { session: "continue", sandbox: "workspace-write", askForApproval: "on-failure", skipGitRepoCheck: true },
    },
  } as HeckleConfig;
  const out = selectionToConfig(custom, { agent: "cursor", session: "persistent", autonomy: "standard" });
  assert.equal(out.delivery.cursor?.force, false);
  assert.equal(out.delivery.codex?.askForApproval, "on-failure");
  assert.equal(out.delivery.codex?.session, "continue"); // explicit opt-in honored for "persistent"
});

test("selectionFromConfig reads the active routing back", () => {
  assert.deepEqual(selectionFromConfig(base), { agent: "claude-code", session: "persistent", autonomy: "standard" });

  const codexCfg = {
    ...base,
    delivery: { ...base.delivery, order: ["codex", "file-inbox", "clipboard"], codex: { session: "continue", sandbox: "danger-full-access" } },
  } as HeckleConfig;
  assert.deepEqual(selectionFromConfig(codexCfg), { agent: "codex", session: "persistent", autonomy: "full" });

  const inboxCfg = { ...base, delivery: { ...base.delivery, order: ["file-inbox", "clipboard"] } } as HeckleConfig;
  assert.equal(selectionFromConfig(inboxCfg).agent, "inbox");
});

test("round-trip: fromConfig(toConfig(sel)) === sel", () => {
  const cases = [
    { agent: "claude-code", session: "fresh", autonomy: "full" },
    { agent: "cursor", session: "persistent", autonomy: "standard" },
    { agent: "codex", session: "fresh", autonomy: "standard" },
    { agent: "inbox", session: "persistent", autonomy: "standard" },
  ] as const;
  for (const sel of cases) {
    assert.deepEqual(selectionFromConfig(selectionToConfig(base, sel)), sel);
  }
});

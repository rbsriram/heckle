// The fast lane wired through the orchestrator: a copy trigger drafts a direct edit and, on
// approval, changes source on disk with no provider and no agent. provider is null (the fast lane
// never needs the model), so a behavioral or unresolvable trigger simply produces no draft here,
// proving it did NOT take the fast path.
import type { HeckleConfig, ServerMessage } from "@heckle/shared";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { Orchestrator } from "../src/orchestrator.ts";
import { openDb } from "../../memory/src/index.ts";
import { ReproStore } from "../../replay/src/index.ts";

const config: HeckleConfig = {
  drafting: { provider: "ollama", model: "qwen3:14b", baseUrl: "http://localhost:11434/v1" },
  voice: { provider: "local" },
  delivery: { order: ["claude-code", "file-inbox", "clipboard"] },
  agent: "claude-code",
  privacy: { localOnly: true },
};

function project(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

function newOrchestrator(root: string): { orch: Orchestrator; msgs: ServerMessage[] } {
  const orch = new Orchestrator(config, root, {
    provider: null,
    delivery: { whichFn: async () => false },
    memory: null,
    metrics: null,
    verification: null,
  });
  const msgs: ServerMessage[] = [];
  orch.setEmitter((m) => msgs.push(m));
  return { orch, msgs };
}

async function waitFor<T>(get: () => T | undefined, ms = 2000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("copy trigger drafts, then approve edits source directly (no agent)", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "heckle-fl-"));
  try {
    project(root, { "src/Btn.tsx": "export const B = () => <button>Choose Pro</button>;\n" });
    const { orch, msgs } = newOrchestrator(root);
    const reply = (m: ServerMessage) => msgs.push(m);

    orch.handleMessage(
      JSON.stringify({
        type: "trigger",
        intentText: "call it Go Pro",
        context: {
          url: "http://localhost:3000/",
          console: [],
          network: [],
          selection: { targetText: "Choose Pro", selector: "button", target: { css: "button" }, source: { file: join(root, "src/Btn.tsx"), line: 1 } },
          capturedAt: 1,
        },
      }),
      reply,
    );

    const draft = await waitFor(() => msgs.find((m) => m.type === "draft"));
    if (draft.type !== "draft") throw new Error("no draft");
    assert.match(draft.feedback.intent, /Choose Pro/);
    assert.match(draft.feedback.intent, /Go Pro/);
    // The draft is a preview only: nothing written until approval.
    assert.match(readFileSync(join(root, "src/Btn.tsx"), "utf8"), /Choose Pro/);

    orch.handleMessage(JSON.stringify({ type: "approve", feedbackId: draft.feedback.id }), reply);
    const status = await waitFor(() => msgs.find((m) => m.type === "fixStatus"));
    assert.equal(status.type === "fixStatus" ? status.ok : false, true);

    const after = readFileSync(join(root, "src/Btn.tsx"), "utf8");
    assert.match(after, /<button>Go Pro<\/button>/);
    assert.doesNotMatch(after, /Choose Pro/);
    const artifact = new ReproStore(root).list()[0];
    assert.equal(artifact.assertions[0].type, "text_equals");
    assert.deepEqual(artifact.surfaces?.files, ["src/Btn.tsx"]);
    const db = openDb(join(root, ".heckle", "heckle.db"));
    const fix = db.prepare(`SELECT authority FROM fixes WHERE repro_id=?`).get(artifact.id) as { authority: string };
    assert.equal(fix.authority, "deterministic");
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("style trigger drafts and applies a guarded Tailwind AST edit", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "heckle-fl-style-"));
  try {
    project(root, { "src/Btn.tsx": `export const B = () => <button className="bg-red-500 p-2">Go</button>;\n` });
    const { orch, msgs } = newOrchestrator(root);
    const reply = (message: ServerMessage) => msgs.push(message);
    orch.handleMessage(JSON.stringify({
      type: "trigger",
      intentText: "make the background blue",
      context: {
        url: "http://localhost:3000/",
        console: [],
        network: [],
        selection: {
          selector: "button",
          target: { css: "button" },
          className: "bg-red-500 p-2",
          source: { file: join(root, "src/Btn.tsx"), line: 1 },
        },
        capturedAt: 1,
      },
    }), reply);
    const draft = await waitFor(() => msgs.find((message) => message.type === "draft"));
    if (draft.type !== "draft") throw new Error("no draft");
    orch.handleMessage(JSON.stringify({ type: "approve", feedbackId: draft.feedback.id }), reply);
    await waitFor(() => msgs.find((message) => message.type === "fixStatus"));
    assert.match(readFileSync(join(root, "src/Btn.tsx"), "utf8"), /bg-blue-500 p-2/);
    assert.equal(msgs.some((message) => message.type === "delivered" && message.results[0]?.detail?.includes("heckle undo")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("behavioral trigger does not take the fast lane, source untouched", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "heckle-fl2-"));
  try {
    project(root, { "src/Btn.tsx": "<button>Choose Pro</button>\n" });
    const { orch, msgs } = newOrchestrator(root);
    const reply = (m: ServerMessage) => msgs.push(m);

    orch.handleMessage(
      JSON.stringify({
        type: "trigger",
        intentText: "the total doesn't update when I change the quantity",
        context: {
          url: "http://x/",
          console: [],
          network: [],
          selection: { targetText: "Choose Pro", source: { file: join(root, "src/Btn.tsx"), line: 1 } },
          capturedAt: 1,
        },
      }),
      reply,
    );

    await new Promise((r) => setTimeout(r, 80));
    assert.equal(msgs.some((m) => m.type === "draft"), false); // provider null + behavioral -> no draft
    assert.match(readFileSync(join(root, "src/Btn.tsx"), "utf8"), /Choose Pro/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("copy the source cannot resolve (interpolated) falls back, source untouched", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "heckle-fl3-"));
  try {
    project(root, { "src/Btn.tsx": "<button>{t('cta')}</button>\n" });
    const { orch, msgs } = newOrchestrator(root);
    const reply = (m: ServerMessage) => msgs.push(m);

    orch.handleMessage(
      JSON.stringify({
        type: "trigger",
        intentText: "call it Go Pro",
        context: { url: "http://x/", console: [], network: [], selection: { targetText: "Choose Pro" }, capturedAt: 1 },
      }),
      reply,
    );

    await new Promise((r) => setTimeout(r, 80));
    assert.equal(msgs.some((m) => m.type === "draft"), false); // no static literal -> no fast edit
    assert.match(readFileSync(join(root, "src/Btn.tsx"), "utf8"), /\{t\('cta'\)\}/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

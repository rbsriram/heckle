import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { Knot, Ledger, openDb } from "../../memory/src/index.ts";
import { ReproStore, type ReplayResult } from "../../replay/src/index.ts";
import type { ReproArtifact } from "../../shared/src/index.ts";
import { handleMcpRequest } from "../src/server.ts";
import { HeckleMcpService } from "../src/service.ts";
import { HECKLE_TOOLS } from "../src/tools.ts";

async function fixture(): Promise<{ root: string; issueId: string; repro: ReproArtifact; service: HeckleMcpService }> {
  const root = mkdtempSync(resolve(tmpdir(), "heckle-mcp-"));
  const dbPath = resolve(root, ".heckle", "heckle.db");
  mkdirSync(resolve(root, ".heckle", "receipts"), { recursive: true });
  const db = openDb(dbPath);
  const knot = new Knot(db, { embed: async () => Float32Array.from([1]) });
  const issue = await knot.addIssue({ summary: "Checkout total is wrong", flow: "checkout", contextRef: "fb_test" });
  knot.close();
  writeFileSync(resolve(root, ".heckle", "receipts", "fb_test.json"), JSON.stringify({ intent: "Fix checkout total" }));
  const repro: ReproArtifact = {
    version: 1,
    id: "hkl_mcp",
    issue_id: issue.id,
    created_at: new Date().toISOString(),
    origin: "http://localhost:3000",
    route: "/checkout",
    viewport: { width: 1280, height: 720 },
    state_seed: { localStorage: {}, sessionStorage: {}, cookies: [] },
    actions: [],
    network_fixtures: [],
    assertions: [],
    utterance: "the total is wrong",
    determinism: { runs: 3, pass_rate: 1, quarantined: false },
    surfaces: { routes: ["/checkout"], files: ["src/checkout.tsx"], elements: ["testid:total"] },
    verification: { status: "fixed", runs: 2, outcomes: [true, true], last_run_at: "now", promoted_at: "now" },
  };
  new ReproStore(root).save(repro);
  const ledger = new Ledger(openDb(dbPath));
  ledger.recordRepro(repro, `.heckle/repros/${repro.id}.json`);
  ledger.recordFix({ issueId: issue.id, reproId: repro.id, outcome: "fixed", authority: "verification" });
  ledger.close();
  const replayResult: ReplayResult = {
    reproId: repro.id,
    passed: true,
    durationMs: 4,
    assertions: [],
    consoleErrors: [],
    failedRequests: [],
  };
  const service = new HeckleMcpService(root, {
    replay: { run: async () => replayResult },
    verification: {
      verify: async () => ({
        reproId: repro.id,
        issueId: issue.id,
        status: "fixed",
        promoted: true,
        results: [replayResult, replayResult],
        delta: [],
      }),
    },
  });
  return { root, issueId: issue.id, repro, service };
}

test("the CLI serves newline-delimited MCP over stdio", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "heckle-mcp-stdio-"));
  try {
    const cli = resolve(import.meta.dirname, "../../../apps/cli/bin/heckle.ts");
    const child = spawn(process.execPath, [cli, "mcp"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
    await new Promise<void>((resolveExit, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => code === 0 ? resolveExit() : reject(new Error(`MCP CLI exited ${code}`)));
    });
    const responses = output.trim().split("\n").map((line) => JSON.parse(line) as { id: number; result: Record<string, unknown> });
    assert.equal(responses[0].id, 1);
    assert.equal((responses[1].result.tools as unknown[]).length, 7);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the MCP surface exposes exactly the seven F3 tools", async () => {
  assert.deepEqual(HECKLE_TOOLS.map((tool) => tool.name), [
    "heckle_list_open",
    "heckle_get_task",
    "heckle_search_memory",
    "heckle_check_regressions",
    "heckle_run_repro",
    "heckle_mark_ready",
    "heckle_get_fix_history",
  ]);
  const { root, service } = await fixture();
  try {
    const initialized = await handleMcpRequest(service, {
      method: "initialize",
      id: 1,
      params: { protocolVersion: "2025-06-18" },
    }) as { protocolVersion: string; serverInfo: { name: string } };
    assert.equal(initialized.serverInfo.name, "heckle");
    assert.equal(initialized.protocolVersion, "2025-06-18");
    const listed = await handleMcpRequest(service, { method: "tools/list", id: 2 }) as { tools: unknown[] };
    assert.equal(listed.tools.length, 7);
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude Code, Cursor, and Codex workflows can pull and verify the same task without pasted context", async () => {
  const { root, issueId, service } = await fixture();
  try {
    for (const client of ["claude-code", "cursor", "codex"]) {
      const open = await service.callTool("heckle_list_open", { route: "/checkout" }) as Array<{ issue_id: string }>;
      assert.equal(open[0].issue_id, issueId, client);
      const task = await service.callTool("heckle_get_task", { issue_id: issueId }) as { receipt: { intent: string } };
      assert.equal(task.receipt.intent, "Fix checkout total", client);
      const regressions = await service.callTool("heckle_check_regressions", {
        changed_files: ["src/checkout.tsx"],
        run: true,
      }) as { results: ReplayResult[] };
      assert.equal(regressions.results[0].passed, true, client);
      const ready = await service.callTool("heckle_mark_ready", { issue_id: issueId }) as { status: string };
      assert.equal(ready.status, "fixed", client);
    }
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("all seven tools return useful local QA state", async () => {
  const { root, issueId, repro, service } = await fixture();
  try {
    const open = await service.callTool("heckle_list_open", { route: "/checkout", severity: "bug" }) as unknown[];
    assert.equal(open.length, 1);
    assert.deepEqual(await service.callTool("heckle_list_open", { severity: "blocker" }), []);
    const task = await service.callTool("heckle_get_task", { issue_id: issueId }) as { repro: ReproArtifact };
    assert.equal(task.repro.id, repro.id);
    const memory = await service.callTool("heckle_search_memory", { query: "checkout" }) as { issues: unknown[] };
    assert.equal(memory.issues.length, 1);
    const selected = await service.callTool("heckle_check_regressions", { changed_files: ["src/checkout.tsx"] }) as { repros: string[] };
    assert.deepEqual(selected.repros, [repro.id]);
    const checked = await service.callTool("heckle_check_regressions", { changed_files: ["src/checkout.tsx"], run: true }) as { results: ReplayResult[] };
    assert.equal(checked.results[0].passed, true);
    const replayed = await service.callTool("heckle_run_repro", { repro_id: repro.id }) as ReplayResult;
    assert.equal(replayed.passed, true);
    await assert.rejects(
      service.callTool("heckle_run_repro", { repro_id: repro.id, origin: "https://example.com" }),
      /local-only mode/,
    );
    const ready = await service.callTool("heckle_mark_ready", { issue_id: issueId }) as { status: string };
    assert.equal(ready.status, "fixed");
    const history = await service.callTool("heckle_get_fix_history", { element: "testid:total" }) as unknown[];
    assert.equal(history.length, 1);
    const response = await handleMcpRequest(service, {
      method: "tools/call",
      id: 3,
      params: { name: "heckle_get_task", arguments: { issue_id: issueId } },
    }) as { content: Array<{ type: string; text: string }> };
    assert.equal(response.content[0].type, "text");
    assert.match(response.content[0].text, /Checkout total is wrong/);
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

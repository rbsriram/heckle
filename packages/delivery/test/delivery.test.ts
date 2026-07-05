// M3: delivery adapters + chain. Spawn/which are injected so nothing real (claude) runs;
// the clipboard test does a real pbcopy/pbpaste round-trip on macOS.
import type { ContextBundle, Feedback } from "@heckle/shared";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  ClaudeCodeDispatchAdapter,
  ClipboardAdapter,
  CodexDispatchAdapter,
  createDeliveryChain,
  CursorDispatchAdapter,
  FileInboxAdapter,
  formatFeedbackMarkdown,
  type SpawnFn,
} from "../src/index.ts";
import { parseClaudeStreamLine } from "../src/agent-dispatch.ts";

const config = {
  drafting: { provider: "ollama", model: "qwen3:14b", baseUrl: "http://localhost:11434/v1" },
  voice: { provider: "local" },
  delivery: { order: ["claude-code", "file-inbox", "clipboard"] },
  agent: "claude-code",
  privacy: { localOnly: true },
} as const;

const feedback: Feedback = {
  id: "fb_test1",
  intent: "Recompute the total when quantity changes",
  target: { flow: "checkout" },
  severity: "bug",
  repro: ["Open checkout", "Click +", "Total stays $20"],
  context: { consoleRefs: ["c1"], networkRefs: ["n1"] },
  fixHint: "Update total on qty change",
  history: null,
};

const context: ContextBundle = {
  url: "http://localhost:5173/checkout",
  flow: "checkout",
  console: [{ id: "c1", level: "error", args: ["TypeError: total is undefined"], ts: 1 }],
  network: [{ id: "n1", method: "POST", url: "/api/order", status: 500, ok: false, ts: 2 }],
  capturedAt: 3,
};

function tmp(): string {
  return mkdtempSync(resolve(tmpdir(), "heckle-m3-"));
}

test("formatFeedbackMarkdown resolves console/network receipts", () => {
  const md = formatFeedbackMarkdown(feedback, context);
  assert.match(md, /## Recompute the total/);
  assert.match(md, /\*\*Severity:\*\* bug/);
  assert.match(md, /TypeError: total is undefined/);
  assert.match(md, /POST \/api\/order -> 500/);
  assert.match(md, /Update total on qty change/);
});

test("FileInboxAdapter appends to .heckle/inbox.md", async () => {
  const root = tmp();
  try {
    const inbox = new FileInboxAdapter(root);
    const r1 = await inbox.deliver(feedback, context);
    assert.ok(r1.ok);
    assert.ok(existsSync(inbox.path));
    const r2 = await inbox.deliver(feedback, context);
    assert.ok(r2.ok);
    const content = readFileSync(inbox.path, "utf8");
    assert.match(content, /Recompute the total/);
    assert.equal(content.split("\n---\n").length - 1, 2, "two appended entries");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ClaudeCodeDispatchAdapter builds the right headless command", () => {
  const a = new ClaudeCodeDispatchAdapter({ projectRoot: "/x", whichFn: async () => true });
  const prompt = a.buildPrompt(feedback, context);
  assert.match(prompt, /fb_test1/);
  assert.match(prompt, /\.heckle\/inbox\.md/);
  // No session id and no allowlist -> the minimal edits-only command (stream-json drives the
  // live progress line).
  assert.deepEqual(a.buildArgs(prompt), [
    "-p",
    prompt,
    "--permission-mode",
    "acceptEdits",
    "--output-format",
    "stream-json",
    "--verbose",
  ]);
});

test("ClaudeCodeDispatchAdapter: --session-id to create, --resume to continue, allowlist last", () => {
  const a = new ClaudeCodeDispatchAdapter({
    projectRoot: "/x",
    permissionMode: "acceptEdits",
    allowedTools: ["Edit", "Bash(npm test:*)"],
    whichFn: async () => true,
  });
  // New session -> --session-id. allowedTools stays last (variadic).
  assert.deepEqual(a.buildArgs("do it", { id: "sess-123", resume: false }), [
    "-p",
    "do it",
    "--permission-mode",
    "acceptEdits",
    "--output-format",
    "stream-json",
    "--verbose",
    "--session-id",
    "sess-123",
    "--allowedTools",
    "Edit",
    "Bash(npm test:*)",
  ]);
  // Existing session -> --resume (reusing --session-id errors "already in use").
  const resumed = a.buildArgs("do it", { id: "sess-123", resume: true });
  assert.deepEqual(resumed.slice(resumed.indexOf("--resume"), resumed.indexOf("--resume") + 2), ["--resume", "sess-123"]);
});

test("resolveSession: persistent mints then resumes a persisted id; fresh none; pinned resumes", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "heckle-sess-"));
  try {
    const persistent = new ClaudeCodeDispatchAdapter({ projectRoot: dir, session: "persistent", whichFn: async () => true });
    const first = persistent.resolveSession();
    assert.equal(first?.resume, false, "first dispatch creates the session");
    assert.ok(first?.id);
    // NOT persisted by resolveSession: only a clean create dispatch writes the file (a failed
    // create would otherwise poison every later --resume). Until then, each resolve re-creates.
    assert.equal(existsSync(resolve(dir, ".heckle/claude-session-id")), false);
    assert.equal(persistent.resolveSession()?.resume, false);
    // Once the id is on disk (the create exited clean), later dispatches resume the SAME id.
    mkdirSync(resolve(dir, ".heckle"), { recursive: true });
    writeFileSync(resolve(dir, ".heckle/claude-session-id"), first!.id);
    assert.deepEqual(persistent.resolveSession(), { id: first!.id, resume: true });

    const fresh = new ClaudeCodeDispatchAdapter({ projectRoot: dir, session: "fresh", whichFn: async () => true });
    assert.equal(fresh.resolveSession(), undefined);

    const pinned = new ClaudeCodeDispatchAdapter({ projectRoot: dir, session: "550e8400-e29b-41d4-a716-446655440000", whichFn: async () => true });
    assert.deepEqual(pinned.resolveSession(), { id: "550e8400-e29b-41d4-a716-446655440000", resume: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persistent session id is persisted only after the create dispatch exits clean", async () => {
  const dir = tmp();
  try {
    const exits: Array<(code: number) => void> = [];
    const spawnFn: SpawnFn = () => ({
      on(event: string, cb: (...a: unknown[]) => void) {
        if (event === "exit") exits.push(cb as (code: number) => void);
      },
      unref() {},
    });
    const a = new ClaudeCodeDispatchAdapter({ projectRoot: dir, session: "persistent", spawnFn, whichFn: async () => true });
    const sessFile = resolve(dir, ".heckle/claude-session-id");

    await a.deliver(feedback, context);
    assert.equal(existsSync(sessFile), false, "nothing persisted while the create is in flight");
    exits[0](1); // the create FAILED -> still nothing persisted, the next dispatch re-creates
    assert.equal(existsSync(sessFile), false);
    assert.equal(a.resolveSession()?.resume, false);

    await a.deliver(feedback, context);
    exits[1](0); // clean create -> this id becomes the project's persistent session
    const id = readFileSync(sessFile, "utf8").trim();
    assert.ok(id);
    assert.deepEqual(a.resolveSession(), { id, resume: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("landed = the working tree changed, NOT the exit code (the FAILED-but-it-worked bug)", async () => {
  const dir = tmp();
  try {
    execFileSync("git", ["init", dir], { stdio: "ignore" });
    const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore" });
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    writeFileSync(resolve(dir, "app.js"), "const x = 1;\n");
    git("add", "-A");
    git("commit", "-m", "init");

    const deliverWith = (spawnFn: SpawnFn): Promise<boolean> =>
      new Promise((res) => {
        void new ClaudeCodeDispatchAdapter({ projectRoot: dir, session: "fresh", spawnFn, whichFn: async () => true, onComplete: (ok) => res(ok) }).deliver(
          feedback,
          context,
        );
      });

    // The agent edits the file (fix lands) then exits NON-ZERO (its self-check was blocked).
    let editExit: ((c: number) => void) | undefined;
    const landed = await deliverWith(() => {
      writeFileSync(resolve(dir, "app.js"), "const x = 2; // fixed\n");
      queueMicrotask(() => editExit?.(1));
      return { on: (e: string, cb: (...a: unknown[]) => void) => (e === "exit" ? (editExit = cb) : undefined) };
    });
    assert.equal(landed, true, "files changed -> Fixed, even though the process exited non-zero");

    // Control: the agent changes nothing and exits 0 -> it did NOT land.
    let noopExit: ((c: number) => void) | undefined;
    const landedNoop = await deliverWith(() => {
      queueMicrotask(() => noopExit?.(0));
      return { on: (e: string, cb: (...a: unknown[]) => void) => (e === "exit" ? (noopExit = cb) : undefined) };
    });
    assert.equal(landedNoop, false, "nothing changed -> Didn't land, even though the process exited 0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseClaudeStreamLine turns stream-json events into one short activity line", () => {
  const asst = (content: unknown[]) => JSON.stringify({ type: "assistant", message: { content } });
  assert.equal(parseClaudeStreamLine(asst([{ type: "tool_use", name: "Edit", input: { file_path: "/repo/src/Hero.tsx" } }])), "Editing Hero.tsx");
  assert.equal(parseClaudeStreamLine(asst([{ type: "tool_use", name: "Read", input: { file_path: "/repo/a/b.ts" } }])), "Reading b.ts");
  assert.equal(parseClaudeStreamLine(asst([{ type: "tool_use", name: "Bash", input: { description: "Run the tests" } }])), "Run the tests");
  assert.equal(parseClaudeStreamLine(asst([{ type: "text", text: "thinking out loud" }])), undefined, "plain prose is not activity");
  assert.equal(parseClaudeStreamLine(JSON.stringify({ type: "result", subtype: "success" })), "Wrapping up");
  assert.equal(parseClaudeStreamLine("not json"), undefined);
});

test("ClaudeCodeDispatchAdapter.isAvailable uses the which probe", async () => {
  assert.equal(await new ClaudeCodeDispatchAdapter({ projectRoot: "/x", whichFn: async () => false }).isAvailable(), false);
  assert.equal(await new ClaudeCodeDispatchAdapter({ projectRoot: "/x", whichFn: async () => true }).isAvailable(), true);
});

test("CursorDispatchAdapter builds `-p --force --workspace ... --resume <id> <prompt>`", () => {
  const a = new CursorDispatchAdapter({ projectRoot: "/x", whichFn: async () => true });
  assert.deepEqual(a.buildArgs("do it", "chat-9"), ["-p", "--force", "--workspace", "/x", "--resume", "chat-9", "do it"]);
  // --force off + model, no session
  const b = new CursorDispatchAdapter({ projectRoot: "/x", force: false, model: "auto", whichFn: async () => true });
  assert.deepEqual(b.buildArgs("go"), ["-p", "--workspace", "/x", "--model", "auto", "go"]);
});

test("CursorDispatchAdapter.resolveSessionId: persisted reused, fresh none, pinned passthrough", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "heckle-cur-"));
  try {
    // Seed a persisted chat id so we exercise reuse without the live `create-chat` mint.
    mkdirSync(resolve(dir, ".heckle"), { recursive: true });
    writeFileSync(resolve(dir, ".heckle/cursor-session-id"), "chat-persisted");
    const persistent = new CursorDispatchAdapter({ projectRoot: dir, session: "persistent", whichFn: async () => true });
    assert.equal(await persistent.resolveSessionId(), "chat-persisted");
    const fresh = new CursorDispatchAdapter({ projectRoot: dir, session: "fresh", whichFn: async () => true });
    assert.equal(await fresh.resolveSessionId(), undefined);
    const pinned = new CursorDispatchAdapter({ projectRoot: dir, session: "chat-xyz", whichFn: async () => true });
    assert.equal(await pinned.resolveSessionId(), "chat-xyz");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CursorDispatchAdapter.isAvailable probes cursor-agent", async () => {
  let probed = "";
  const a = new CursorDispatchAdapter({
    projectRoot: "/x",
    whichFn: async (c) => {
      probed = c;
      return true;
    },
  });
  assert.equal(await a.isAvailable(), true);
  assert.equal(probed, "cursor-agent");
});

test("CodexDispatchAdapter builds `exec [resume ...] --cd ... --sandbox ... --ask-for-approval ...`", () => {
  const fresh = new CodexDispatchAdapter({ projectRoot: "/x", whichFn: async () => true });
  assert.deepEqual(fresh.buildArgs("do it"), [
    "exec",
    "--cd",
    "/x",
    "--sandbox",
    "workspace-write",
    "--ask-for-approval",
    "never",
    "--skip-git-repo-check",
    "do it",
  ]);
  // "continue" -> resume the newest session in the project dir
  const cont = new CodexDispatchAdapter({ projectRoot: "/x", session: "continue", whichFn: async () => true });
  assert.deepEqual(cont.buildArgs("go").slice(0, 3), ["exec", "resume", "--last"]);
  // pinned id + model, git check left on
  const pinned = new CodexDispatchAdapter({
    projectRoot: "/x",
    session: "sess-77",
    model: "gpt-5-codex",
    skipGitRepoCheck: false,
    whichFn: async () => true,
  });
  assert.deepEqual(pinned.buildArgs("go"), [
    "exec",
    "resume",
    "sess-77",
    "--cd",
    "/x",
    "--sandbox",
    "workspace-write",
    "--ask-for-approval",
    "never",
    "--model",
    "gpt-5-codex",
    "go",
  ]);
});

test("CodexDispatchAdapter.isAvailable probes codex", async () => {
  let probed = "";
  const a = new CodexDispatchAdapter({
    projectRoot: "/x",
    whichFn: async (c) => {
      probed = c;
      return true;
    },
  });
  assert.equal(await a.isAvailable(), true);
  assert.equal(probed, "codex");
});

test("chain: order=[cursor] dispatches cursor-agent (fresh session, fake spawn)", async () => {
  const root = tmp();
  try {
    let spawned: { cmd: string; args: readonly string[] } | null = null;
    const fakeSpawn: SpawnFn = (cmd, args) => {
      spawned = { cmd, args };
      return { on: () => {}, unref: () => {} };
    };
    const cfg = { ...config, delivery: { order: ["cursor", "file-inbox", "clipboard"], cursor: { session: "fresh" } } };
    const chain = createDeliveryChain(cfg as never, { projectRoot: root, whichFn: async () => true, spawnFn: fakeSpawn });
    const results = await chain.deliver(feedback, context);
    assert.ok(spawned, "cursor-agent was dispatched");
    assert.equal(spawned!.cmd, "cursor-agent");
    assert.ok(results.some((r) => r.adapter === "cursor" && r.ok));
    assert.ok(!results.some((r) => r.adapter === "clipboard"), "stops at first success");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("chain: order=[codex] dispatches codex exec (fake spawn)", async () => {
  const root = tmp();
  try {
    let spawned: { cmd: string; args: readonly string[] } | null = null;
    const fakeSpawn: SpawnFn = (cmd, args) => {
      spawned = { cmd, args };
      return { on: () => {}, unref: () => {} };
    };
    const cfg = { ...config, delivery: { order: ["codex", "file-inbox", "clipboard"] } };
    const chain = createDeliveryChain(cfg as never, { projectRoot: root, whichFn: async () => true, spawnFn: fakeSpawn });
    const results = await chain.deliver(feedback, context);
    assert.ok(spawned, "codex was dispatched");
    assert.equal(spawned!.cmd, "codex");
    assert.equal(spawned!.args[0], "exec");
    assert.ok(results.some((r) => r.adapter === "codex" && r.ok));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("chain: claude-code available -> inbox written + dispatched, clipboard not reached", async () => {
  const root = tmp();
  try {
    let spawned: { cmd: string; args: readonly string[] } | null = null;
    const fakeSpawn: SpawnFn = (cmd, args) => {
      spawned = { cmd, args };
      return { on: () => {}, unref: () => {}, stdin: { end: () => {} } };
    };
    const chain = createDeliveryChain(config, { projectRoot: root, whichFn: async () => true, spawnFn: fakeSpawn });
    const results = await chain.deliver(feedback, context);

    assert.equal(results[0].adapter, "file-inbox");
    assert.ok(results[0].ok, "inbox always written");
    assert.ok(existsSync(chain.inboxPath));
    assert.ok(spawned, "claude was dispatched");
    assert.equal(spawned!.cmd, "claude");
    assert.ok(results.some((r) => r.adapter === "claude-code" && r.ok));
    assert.ok(!results.some((r) => r.adapter === "clipboard"), "clipboard not reached");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("chain: claude-code unavailable -> falls to file-inbox floor", async () => {
  const root = tmp();
  try {
    const chain = createDeliveryChain(config, { projectRoot: root, whichFn: async () => false });
    const results = await chain.deliver(feedback, context);
    assert.ok(results[0].ok, "inbox written");
    assert.ok(results.some((r) => r.adapter === "claude-code" && !r.ok), "claude-code marked unavailable");
    assert.ok(!results.some((r) => r.adapter === "clipboard"), "stops at inbox floor");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "ClipboardAdapter copies via pbcopy (round-trip)",
  { skip: process.platform === "darwin" ? false : "macOS only" },
  async () => {
    const r = await new ClipboardAdapter().deliver(feedback, context);
    assert.ok(r.ok, r.detail);
    const pasted = execFileSync("pbpaste").toString();
    assert.match(pasted, /Recompute the total/);
  },
);

// heckle init: installing the agent context (convention docs + Claude Code skill).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { hasAgentContext, hasAnyAgentContext, installAgentContext } from "../src/agent-context.ts";

test("installAgentContext writes CLAUDE.md convention + skill, idempotently", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "heckle-init-"));
  try {
    const r1 = installAgentContext(dir, "claude-code");
    assert.ok(r1.written.some((p) => p.endsWith("CLAUDE.md")));
    assert.ok(existsSync(resolve(dir, ".claude/skills/heckle/SKILL.md")));
    assert.match(readFileSync(resolve(dir, "CLAUDE.md"), "utf8"), /Heckle QA inbox/);
    assert.match(readFileSync(resolve(dir, ".claude/skills/heckle/SKILL.md"), "utf8"), /name: heckle/);

    // Idempotent: a second run skips the doc (marker already present), does not duplicate.
    const r2 = installAgentContext(dir, "claude-code");
    assert.ok(r2.skipped.some((p) => p.endsWith("CLAUDE.md")));
    const claude = readFileSync(resolve(dir, "CLAUDE.md"), "utf8");
    assert.equal(claude.match(/Heckle QA inbox/g)?.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("installAgentContext all also writes AGENTS.md + .cursorrules", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "heckle-init-"));
  try {
    installAgentContext(dir, "all");
    assert.match(readFileSync(resolve(dir, "AGENTS.md"), "utf8"), /Heckle QA inbox/);
    assert.match(readFileSync(resolve(dir, ".cursorrules"), "utf8"), /Heckle QA inbox/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an installed skill counts as claude-code context even without the CLAUDE.md block", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "heckle-init-"));
  try {
    installAgentContext(dir, "claude-code");
    // The user keeps the skill but strips the doc block (e.g. their CLAUDE.md documents
    // the convention by hand). Auto-init must not re-append the block over that choice.
    rmSync(resolve(dir, "CLAUDE.md"));
    assert.equal(hasAgentContext(dir, "claude-code"), true);
    assert.equal(hasAnyAgentContext(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hasAgentContext / hasAnyAgentContext detect a first run (drives dev auto-init)", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "heckle-init-"));
  try {
    // Fresh project: nothing installed, so dev should treat it as a first run.
    assert.equal(hasAnyAgentContext(dir), false);
    assert.equal(hasAgentContext(dir, "claude-code"), false);
    assert.equal(hasAgentContext(dir, "cursor"), false);

    installAgentContext(dir, "cursor");
    // Cursor is now taught: any-context is true, but claude-code specifically is not.
    assert.equal(hasAnyAgentContext(dir), true);
    assert.equal(hasAgentContext(dir, "cursor"), true);
    assert.equal(hasAgentContext(dir, "claude-code"), false);
    assert.equal(hasAgentContext(dir, "all"), false);

    installAgentContext(dir, "all");
    assert.equal(hasAgentContext(dir, "claude-code"), true);
    assert.equal(hasAgentContext(dir, "codex"), true);
    assert.equal(hasAgentContext(dir, "all"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

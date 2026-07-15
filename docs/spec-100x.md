# Heckle 100x Specification

Version 1.0. Draft for build. Supersedes the current README-level scope.

---

## 1. Thesis

Heckle today is faster bug reporting. Heckle 100x is a QA system that writes itself from usage.

Three claims define the product:

1. **Every heckle becomes a permanent, replayable test.** A complaint is not a message that evaporates after the fix. It is captured as a deterministic repro that runs forever as a regression test.
2. **The agent pulls from Heckle, not just Heckle pushing to the agent.** Heckle is an MCP server that any coding agent queries before and after changes.
3. **Trivial changes bypass the agent entirely.** Copy, colour, spacing, and visibility edits resolve to deterministic source codemods and apply in under one second.

Positioning sentence: complaints become tests, tweaks apply themselves.

Explicit non-positioning: Heckle is not an app builder. It does not compete with Lovable, v0, Bolt, or Onlook on "talk and it builds itself." It owns the quality loop of an app that already exists.

---

## 1.1 Positioning and differentiation

**Category.** Heckle creates its own slot: the QA loop for agentic development. It is not bug reporting, not session replay, not test automation, not visual editing, though it borrows one arc from each.

**The one-sentence claim.** Heckle is the only tool that closes the loop from a spoken complaint to a verified fix to a permanent regression test, locally, inside the coding agent's own workflow.

**Why the loop is the moat.** Every adjacent product owns one arc of this loop and stops:

| Product | What it owns | Where it stops |
|---|---|---|
| Jam.dev, Bird Eats Bug | Context capture (console, network, replay video) | Output is a ticket for a human. No agent handoff, no repro replay, no verification, no test asset |
| Meticulous | Session-to-test generation | Cloud-hosted, records everything indiscriminately, carries no human intent about what is wrong, no fix loop |
| Replay.io | Deterministic recording | Built for debugging, not fixing. Heavy runtime, no agent integration, no accumulating suite |
| Onlook | Visual editing on local React | No QA memory, no tests, no verification. Owns the instant lane arc only |
| Playwright MCP, Chrome DevTools MCP | Agent eyes on the browser | Human is out of the loop. Nothing persists between sessions, no test asset produced |
| Sentry, LogRocket | Production error monitoring | After the fact. No repro-from-usage, not in the dev loop, no fix verification |
| QA Wolf, Octomind, Momentic | Test authoring and maintenance | Tests are deliberate work someone commissions and pays for. Not a byproduct of usage |

**The structural insight.** Tests written deliberately are a cost. Tests that accumulate as a side effect of a human using the app and complaining are free. No competitor produces that byproduct, and none can add it without rebuilding, because it requires owning capture, human intent, repro, agent handoff, and verification simultaneously. Owning four of the five is worth nothing; the asset only exists when the loop closes.

**Secondary differentiators** (real, but not the lead): voice-native input, local-first with a local model by default (nothing leaves the machine), agent-agnostic (Claude Code, Cursor, Codex, or file handoff), sub-second instant lane for literal edits.

**Messaging hierarchy.**
1. Category line: the QA loop for agentic development.
2. Product line: complaints become tests, tweaks apply themselves.
3. Proof line: say what is wrong once. Heckle turns it into a task with the evidence attached, verifies the fix actually landed, and keeps it as a regression test forever.

**What Heckle never claims.** "Build apps by talking." That sentence belongs to a funded, crowded market (Lovable, v0, Bolt) and breaks at the exact moment demos get ambitious. Heckle's claim starts where theirs ends: the app exists, now keep it working.

---

## 2. System overview

One capture layer, three lanes, one memory.

```
                        ┌─────────────────────────────┐
  user talks/types ───► │  Capture layer (in-page)    │
  ambient signals  ───► │  DOM, console, network,     │
                        │  path, element, utterance   │
                        └──────────────┬──────────────┘
                                       │
                              ┌────────▼────────┐
                              │  Router          │
                              │  (rules + LLM)   │
                              └──┬──────┬──────┬─┘
                     instant lane│      │agent │ambient lane
                                 │      │lane  │
                    ┌────────────▼┐  ┌──▼───────────┐  ┌▼──────────────┐
                    │ Codemod     │  │ Task + repro │  │ Signal digest │
                    │ engine      │  │ → agent (MCP │  │ → proposed    │
                    │ (<1s, AST)  │  │ or file)     │  │   tasks       │
                    └──────┬──────┘  └──────┬───────┘  └──────┬────────┘
                           │                │                 │
                           └───────┬────────┴────────┬────────┘
                                   │                 │
                          ┌────────▼───────┐ ┌───────▼────────┐
                          │ Verification   │ │ Memory (Knot-  │
                          │ engine (replay │ │ style ledger)  │
                          │ repro)         │ │                │
                          └────────────────┘ └────────────────┘
```

Everything, including instant edits and ambient signals, lands in memory and produces or updates a repro.

---

## 3. Feature specifications

### F1. Repro-as-artifact

**What.** Every heckle produces a self-contained repro file that can be replayed headlessly.

**Repro artifact schema** (JSON, stored per issue under `.heckle/repros/`):

```json
{
  "id": "hkl_01J...",
  "issue_id": "iss_01J...",
  "created_at": "2026-07-15T10:22:00Z",
  "route": "/checkout",
  "viewport": { "width": 1440, "height": 900 },
  "state_seed": {
    "localStorage": {},
    "sessionStorage": {},
    "cookies": []
  },
  "actions": [
    { "type": "goto", "url": "/checkout" },
    { "type": "click", "target": { "testid": "qty-increment", "role": "button", "name": "+", "css": "..." } },
    { "type": "fill", "target": { "testid": "qty-input" }, "value": "3" }
  ],
  "network_fixtures": [
    { "match": "POST /api/cart", "status": 200, "body_ref": "fixtures/cart_01.json" }
  ],
  "assertions": [
    { "type": "text_equals", "target": { "testid": "cart-total" }, "expected": "$36.00" },
    { "type": "console_clean", "levels": ["error"] },
    { "type": "no_failed_requests", "exclude": ["analytics"] }
  ],
  "utterance": "the total does not update when I change the quantity",
  "determinism": { "runs": 3, "pass_rate": 1.0, "quarantined": false }
}
```

**Capture rules.**
- Actions are recorded continuously in a ring buffer (last 50 interactions). On heckle, the buffer is trimmed to the minimal prefix that reproduces: start from last route change, drop interactions on elements outside the flagged element's interaction graph. Trimming is heuristic first, validated by replay.
- Target resolution priority: `data-testid` > ARIA role + accessible name > stable CSS path. All three are stored; replay tries in order.
- Network fixtures: record request/response pairs for non-static requests during the captured window. Replay runs with fixtures ON by default (deterministic) and has a `--live` mode.
- Assertions: the LLM proposes assertions from the utterance plus observed failure (e.g. utterance says "total does not update" and DOM shows stale total, so assert `text_equals` on the total after the action sequence). The user sees and can edit assertions before the task ships, in the same review step that already exists.

**Determinism gate.** A repro is only promoted to the regression suite after passing 3 consecutive replays on the current (broken) or fixed code with the expected result. Flaky repros are quarantined, never silently dropped.

**Replay engine.** Playwright (chromium, headless) driven by a `heckle replay <id>` command. Runs against the local dev server Heckle already wraps. Budget: p50 replay under 10s per repro.

### F2. Verification engine

**What.** "Fixed" means the repro passes, not "the code changed."

**Flow.**
1. Task ships to agent with the repro ID attached.
2. Agent finishes (detected via existing completion signal, or agent calls `heckle_mark_ready` over MCP).
3. Heckle replays the repro. Assertions pass 2 of 2 runs → status **Fixed**. Fail → status **Didn't land**, with the diff between expected and observed attached, and the task re-opens with that delta appended so the agent's second attempt has the failure evidence.
4. On Fixed, the repro joins the regression suite.

**Regression suite.**
- `heckle test` replays all promoted repros. Exit code non-zero on any failure.
- `heckle test --changed` accepts a list of changed files (or reads `git diff --name-only`) and replays only repros whose recorded routes/components intersect the change set, using the element-to-source map from F5.
- Designed to be a one-line addition to CI and a pre-commit hook the agent itself can run.

### F3. MCP server

**What.** Heckle exposes its state as an MCP server so agents pull context instead of only receiving pushes.

**Tool surface (v1):**

| Tool | Input | Output |
|---|---|---|
| `heckle_list_open` | filter (route, severity) | open issues, one line each |
| `heckle_get_task` | issue_id | full task: utterance, DOM excerpt, console, network, repro ref |
| `heckle_search_memory` | free-text query | matching issues/fixes with status and dates |
| `heckle_check_regressions` | changed_files[] | repros intersecting the change set, plus replay results if `run=true` |
| `heckle_run_repro` | repro_id | pass/fail with assertion-level detail |
| `heckle_mark_ready` | issue_id | triggers verification (F2) |
| `heckle_get_fix_history` | element or route | past fixes touching this surface, with outcomes |

**Transport.** stdio for Claude Code/Cursor/Codex local; the `heckle dev` process hosts it. Registration: `claude mcp add heckle -- heckle mcp` documented in README, plus a `.claude/skills/heckle` skill (already present in repo) updated to instruct the agent to call `heckle_check_regressions` before declaring any task done.

**Distribution side effect.** List in the major MCP directories (same playbook already built for Zovery: official registry, Smithery, PulseMCP, mcp.so).

### F4. Ambient capture

**What.** Heckle surfaces problems before the human speaks. The human-flags-it mode is the demo; ambient is the product.

**Signals watched (all in-page, all local):**
- `console.error`, uncaught exceptions, unhandled promise rejections
- Failed network requests: 4xx/5xx on same-origin XHR/fetch, excluding a default ignore list (analytics, source maps) that is user-editable in `heckle.config.ts`
- Optional (off by default): CLS spikes, long tasks over 200ms, hydration mismatches

**Behaviour rules.**
- Never interrupt. Signals accumulate into a session digest shown as a badge count on the `h` button.
- Deduplication by fingerprint: error message template + top stack frame + route. A fingerprint seen 40 times is one entry with a count.
- Threshold: a fingerprint becomes a *proposed task* after 2 occurrences in a session or 1 occurrence with a user-visible symptom (e.g. the failed request was triggered by a click).
- Each proposed task carries the same context bundle and a synthesized repro attempt (the action window preceding the signal). User promotes or dismisses; dismiss is remembered per fingerprint (supersede, not delete).

### F5. Instant edit lane

**What.** Deterministic, sub-second source edits for literal-level changes, no LLM in the hot path.

**Element-to-source mapping.**
- Primary: a Vite/Next dev-mode plugin injects `data-heckle-src="src/components/Cart.tsx:41:8"` attributes at JSX transform time. React first; the plugin is the framework-specific part.
- Fallback: React fiber `_debugSource` where available.
- Coverage target: 95% of rendered elements mappable in a standard Vite React app.

**Interaction.** User clicks/points at an element (existing element-picker), speaks or types the change. Router classifies (see F7). If instant-eligible, the codemod applies, HMR refreshes, and Heckle shows a one-line confirmation with an undo.

**Instant-eligible edit classes (v1), all single-file AST edits via ts-morph/Babel:**
1. Text content: replace JSX text/string literal
2. Tailwind class tokens: colour, spacing, size, weight, radius (token swap within `className`)
3. Inline style literal values
4. Visibility: add/remove `hidden`, conditional short-circuit on a literal `true/false`
5. Sibling reordering within a static JSX list

**Hard guardrails.**
- Instant lane refuses anything requiring more than one file, any change to logic, props flow, imports, or non-literal expressions. Refusals route to the agent lane automatically, with the classification shown.
- Every instant edit is written to memory as a Fix with `authority: deterministic`, is undoable (`heckle undo`), and appends an assertion to the nearest relevant repro (e.g. `text_equals` after a copy change) so instant edits are also protected against regression.

**Latency budget.** Utterance end to HMR-applied: p50 under 800ms, p95 under 2s (classification is rule-first, so most instant edits never touch a model).

### F6. Memory layer

**What.** The per-project ledger of what was flagged, fixed, and verified. Knot architecture applied: supersede, never overwrite.

**Entities.** `Issue`, `Repro`, `Fix`, `Session`, `Element` (stable identity across renames via source position + testid history), `Route`, `Signal` (ambient fingerprints).

**Properties.**
- Bitemporal: every record carries `observed_at` and `valid_from` / `superseded_at`. "This button was flagged in May, fixed in May, regressed in June" is a first-class queryable fact.
- Authority classes, highest to lowest: (1) verification result (replay pass/fail), (2) human utterance/decision, (3) agent claim, (4) heuristic/ambient inference. Conflicts resolve by authority, never by recency alone.
- Storage: SQLite in `.heckle/`, committed-ignorable by default, with an export format. No cloud storage of code or context by default; local stays the trust position.

**Why it is the moat.** Issue + full context + fix diff + verified outcome is labelled data on what humans consider broken and which fixes actually land, per codebase. It compounds and cannot be copied by cloning features.

### F7. Router

**What.** Classifies each utterance into instant / agent / question.

- Stage 1, rules: verb + target patterns over the picked element ("change/make/set" + text/colour/size/spacing/hide/show + literal value present). Covers the bulk of instant-lane traffic with zero model latency.
- Stage 2, LLM (local by default, existing Ollama path): only for utterances rules cannot place. Output is a single label plus, for agent lane, the drafted task.
- Misroute recovery: instant-lane failures (codemod cannot apply cleanly) fall through to agent lane silently, carrying the attempted classification.

### F8. Distribution and install

**Current state is the biggest single lever.** git clone + npm link is a 90 percent drop-off funnel; the repo has 0 stars partly because of it.

1. Publish to npm as `heckle` (or `@heckle/cli` if taken). Entire install story becomes:
   ```
   npx heckle dev -- npm run dev
   ```
   No clone, no link, no config for the default path. Ship this before anything else in this spec.
2. First-run wizard: detect Ollama, offer model pull or paste-a-key, detect Claude Code/Cursor/Codex on PATH, offer MCP registration. Zero to first heckle under 3 minutes.
3. Claude Code plugin/skill published to the marketplace; MCP directory listings (F3).
4. **Escape localhost (capture-only mode).** A single script tag:
   ```html
   <script src="https://cdn.heckle.dev/h.js" data-project="..."></script>
   ```
   Runs the capture layer on any staging/production URL. No agent, no codemods; heckles and ambient signals sync to the developer's local Heckle (relay through a lightweight sync endpoint, or file export for the fully-local purist). This turns Heckle from a solo-dev tool into "put the staging link in front of a design partner and tell them to complain out loud."

### F9. Team layer (later, design now)

- Shared ledger: multiple reporters, one shipper. Roles: reporter (capture-only, script tag), shipper (full CLI, owns the agent).
- Issue states gain an owner and a source ("who heckled this").
- Explicitly phase 6; the data model in F6 must not preclude it (owner and source fields exist from day one, defaulted to `local`).

---

## 4. Non-goals

- No autonomous shipping. The human approval gate before anything reaches the agent stays, permanently.
- No app-builder positioning. No "build me a new page" flows; structural requests route to the agent lane as ordinary tasks.
- No cloud storage of source, DOM, or network bodies by default. Capture-only relay (F8.4) transmits task payloads only, encrypted, and is opt-in.
- No framework sprawl in v1. React + Vite/Next first-class; others get agent lane and capture but not instant lane.

---

## 5. Phasing

| Phase | Scope | Duration | Exit criteria |
|---|---|---|---|
| P0 | npm publish, `npx heckle` flow, first-run wizard | 1 week | Fresh machine to first shipped heckle in under 3 minutes, no clone |
| P1 | Repro capture, replay engine, determinism gate (F1) | 3 weeks | 80% of heckles on the sample app yield a repro that passes the 3-run gate |
| P1.5 | Minimum ledger migration (F6) | 1 week | Versioned SQLite schema has Issue, Repro, Fix, Session, Element, Route, and Signal primitives; bitemporal fields, authority, owner, and source exist before verification writes outcomes |
| P2 | Verification engine, `heckle test`, `--changed` (F2) | 2 weeks | Fixed status driven by replay; regression suite runnable in CI with one line |
| P3 | MCP server, skill update, directory listings (F3) | 2 weeks | Claude Code answers "what's still broken" from Heckle; `heckle_check_regressions` called in the skill's definition-of-done |
| P4 | Ambient capture (F4) | 2 weeks | Console/network signals become proposed tasks with repro attempts; zero interruptions |
| P5 | Instant edit lane (F5, F7), reusing the parked fastlane rule classifier and source-resolution tests | 3 weeks | Replace the prototype splicer with AST edits; p50 under 800ms on the 5 edit classes; misroutes fall through cleanly |
| P6 | Script-tag capture-only mode, team primitives (F8.4, F9) | 3 weeks | A non-technical user on a staging URL files a heckle that lands in the developer's local queue |

P0 ships this week regardless of everything else. The reusable P5 prototype is parked on `fastlane-prototype`; its direct-write orchestrator integration and positional applier do not enter `main` before P5.

---

## 6. Metrics

- **Activation:** fresh install to first shipped heckle, minutes. Target under 3.
- **Repro determinism rate:** repros passing the 3-run gate / repros captured. Target 80% at P1, 90% by P4.
- **Verified fix rate:** tasks reaching Fixed via replay / tasks shipped. Target 70%.
- **Suite growth:** promoted repros per project per week. This is the compounding-asset number.
- **Instant lane share:** utterances resolved in the instant lane / all utterances. Expect 30 to 50% on active UI work.
- **Retention:** projects with 5+ heckles in week 1 that heckle again in week 3.

---

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Selector fragility breaks repros as UI evolves | Triple-target storage (testid/role/css), Element identity in memory tracks renames, quarantine instead of noisy failure |
| Repro flakiness erodes trust in Fixed/Didn't land | Determinism gate before promotion, fixtures-on replay by default, 2-run verification |
| Network fixtures drift from real APIs | `--live` replay mode, fixture staleness warnings after 30 days |
| Source-map coverage gaps outside Vite React | Framework support declared explicitly; uncovered elements route to agent lane, never fail silently |
| Codemod corrupts a file | AST-only edits, single-file constraint, git-clean check before applying, `heckle undo`, refusal on dirty parse |
| Proxy conflicts with dev servers (websockets, HMR) | Passthrough allowlist per framework preset; documented escape hatch to script-tag injection mode locally |
| MCP/agent completion detection unreliable | `heckle_mark_ready` as the explicit contract; timeout fallback with a manual verify button |

---

## 8. Open questions

1. Repro storage format versioning: how aggressively to migrate old repros when the schema changes. Proposal: version field, replay engine supports N-1.
2. Whether `heckle test` should also run as a Claude Code hook (PostToolUse on Edit/Write) by default or only via the skill instruction. Proposal: skill instruction first, hook opt-in.
3. Relay architecture for capture-only mode: hosted sync endpoint (introduces a server, and a business) vs. tunnel-based direct sync. Decide at P6, not before.

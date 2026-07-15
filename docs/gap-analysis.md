# Heckle 100x gap analysis

Audit date: 2026-07-15

Scope: current working tree compared with `docs/spec-100x.md`, features F1 through F9. This is an implementation audit, not a roadmap estimate.

## How to read this

- **Exists** means usable code already implements the named part of the 100x requirement.
- **Partial** means there is relevant code, but it does not satisfy the feature contract.
- **Absent** means no implementation was found.
- The fastlane prototype is parked on the `fastlane-prototype` branch at commit `09f2873`. It is called out separately from the `main` baseline because it does not ship on `main` today.

## Executive summary

| Feature | Overall status | Short version |
|---|---|---|
| F1. Repro-as-artifact | Absent, with capture foundations | Context and rrweb buffers exist; replayable repro artifacts do not. |
| F2. Verification engine | Absent | “Fixed” currently means the working tree changed, not that a repro passed. |
| F3. MCP server | Absent | No MCP transport, command, or tools exist. |
| F4. Ambient capture | Absent, with signal capture foundations | Console and fetch data are continuously buffered, but no signal detection, digest, dedupe, threshold, or proposal flow exists. |
| F5. Instant edit lane | Partial in the parked fastlane prototype | One copy-edit path works, but it is positional text replacement rather than an AST codemod and lacks the required safety, memory, repro, and undo contracts. |
| F6. Memory layer | Partial | SQLite issue recall exists; the 100x ledger and most entities do not. |
| F7. Router | Partial in the parked fastlane prototype | Rules classify copy/style/behavioral requests and failures fall through; there is no complete instant/agent/question router or LLM classification stage. |
| F8. Distribution and install | Partial | The runtime command and basic agent auto-init exist, but the package is private, README still requires clone/link, and there is no full wizard, MCP registration, marketplace distribution, or remote capture mode. |
| F9. Team layer | Absent | No reporter/shipper roles, shared ledger, owner, or source fields exist. |

The largest architectural mismatch is F2: the UI and memory can say **Fixed** after an agent merely changes the working tree. `runDetachedFix()` fingerprints the tree before and after dispatch, and `Orchestrator.onDispatchComplete` turns that change into `fixed`. This is useful delivery telemetry, but it is explicitly weaker than the 100x definition of fixed.

The audit found a phasing mismatch: P5 fastlane work had started before P0–P2. That prototype is now parked off `main`, and the spec phasing inserts a minimum F6 ledger migration between P1 and P2.

## F1. Repro-as-artifact

**Overall: absent as a feature. Existing capture primitives are useful inputs, not replayable repros.**

### Exists today

- Generic fixed-capacity `RingBuffer<T>` support in `packages/capture/src/browser/buffers.ts`.
- Continuous rrweb recording into an 800-event buffer in `packages/capture/src/browser/recorder.ts` and `packages/capture/src/browser/index.ts`.
- Continuous console and fetch metadata capture in `packages/capture/src/browser/buffers.ts`.
- Page URL, pointed element, console entries, network entries, and rrweb events are assembled into `ContextBundle` by `packages/capture/src/browser/context.ts`.
- The drafting model produces human-readable repro steps as `Feedback.repro: string[]` through `packages/providers/src/prompt.ts` and `packages/shared/src/feedback.ts`.
- A best-effort CSS selector and selected element description are captured by `packages/capture/src/browser/target.ts`.

### Partial

- rrweb contains browser interactions, but there is no dedicated, typed 50-action ring buffer matching the repro schema.
- Network capture records method, URL, status, success, and duration. The shared type has optional body fields, but `installFetchCapture()` does not populate request or response bodies, and nothing writes fixtures.
- Targeting has a CSS path and, in the parked prototype, source location. It does not store the required target triple or resolve in `data-testid` then ARIA role/name then CSS order.
- The user can review and edit drafted task text and repro prose. There is no assertion model or assertion editor.

### Absent

- The versioned repro artifact schema and `.heckle/repros/<id>.json` storage.
- Viewport, localStorage, sessionStorage, and cookie state capture.
- Typed actions, route-boundary trimming, interaction-graph trimming, and replay-validated minimization.
- Network fixture files, fixture interception, live mode, and fixture staleness handling.
- Assertion generation and execution (`text_equals`, `console_clean`, `no_failed_requests`).
- Playwright replay, `heckle replay <id>`, assertion-level results, and the p50 replay budget.
- Three-run determinism promotion, pass rate, quarantine, and regression-suite promotion.

### Existing modules this feature would touch

- `packages/shared/src/types.ts` and `packages/shared/src/feedback.ts`: repro, action, target, fixture, assertion, and determinism contracts.
- `packages/capture/src/browser/buffers.ts`, `recorder.ts`, `context.ts`, `target.ts`, and `index.ts`: action/state capture and stable target descriptors.
- `packages/providers/src/prompt.ts` and provider parsing: proposed assertions.
- `packages/daemon/src/orchestrator.ts`: artifact assembly, review, persistence, and promotion flow.
- `packages/daemon/src/server.ts`: replay/asset coordination with the wrapped app.
- `apps/cli/src/cli.ts` and a new replay command module.
- A new replay-focused module or package for Playwright and fixture handling.

## F2. Verification engine

**Overall: absent. The current completion signal measures changed files, not correctness.**

### Exists today

- Delivery adapters report process completion through `packages/delivery/src/agent-dispatch.ts`.
- `runDetachedFix()` computes pre/post working-tree signatures and reports whether any file state changed.
- The daemon pushes live progress and a final `fixStatus` to the widget through `packages/daemon/src/orchestrator.ts`.
- Capture history persists `fixed` and `failed` outcomes in `.heckle/captures.json` through `packages/daemon/src/captures.ts`.
- The issue memory can transition an issue to `fixed` through `Knot.markFixed()` in `packages/memory/src/knot.ts`.

### Partial

- Agent completion detection exists for Heckle-owned background agent processes. There is no explicit ready contract for an external agent session.
- “Didn’t land” UI state exists, but it means no working-tree delta was detected. It does not mean a replay assertion failed.
- The parked prototype's source-location data could later support changed-file intersection, but no route/component-to-repro index exists.

### Absent

- A repro ID attached to the shipped task.
- Replay on completion and the two-of-two verification gate.
- Expected-versus-observed assertion diffs.
- Automatic reopen with failure evidence for a second agent attempt.
- Promotion into a regression suite after verification.
- `heckle test`, `heckle test --changed`, changed-file discovery, and non-zero failure exit behavior.
- CI/pre-commit integration.
- Manual verify and MCP `heckle_mark_ready` entry points.

### Existing modules this feature would touch

- `packages/delivery/src/format.ts`, `file-inbox.ts`, and `agent-dispatch.ts`: carry repro references and separate agent completion from verification.
- `packages/daemon/src/orchestrator.ts`: replace working-tree-change status with a verification state machine.
- `packages/daemon/src/captures.ts`: persist verifying, fixed, failed, reopened, and assertion-delta state.
- `packages/memory/src/db.ts` and `knot.ts`: verification outcomes, fix records, promotion, and authority.
- `packages/capture/src/browser/widget.ts`: verification progress and assertion-level failures.
- `apps/cli/src/cli.ts` plus test/replay commands.
- The F1 replay engine.

## F3. MCP server

**Overall: absent.**

### Exists today

- The daemon already owns the state that an MCP layer would expose: capture history, delivery lifecycle, and the memory object.
- `Knot.recall()` provides semantic issue search in `packages/memory/src/knot.ts`.
- A local Heckle skill exists at `.claude/skills/heckle/SKILL.md`, and generated agent context is defined in `packages/delivery/src/agent-context.ts`.
- The CLI and daemon already have command and process entry points that can host another transport.

### Partial

- The skill teaches agents to read `.heckle/inbox.md`, run tests, and mark items done. It does not call `heckle_check_regressions` or any MCP tool.
- HTTP and WebSocket transports exist in `packages/daemon/src/server.ts` and `ws.ts`, but MCP requires a stdio server for the stated v1 contract.

### Absent

- `heckle mcp` and stdio MCP transport.
- All seven v1 tools: `heckle_list_open`, `heckle_get_task`, `heckle_search_memory`, `heckle_check_regressions`, `heckle_run_repro`, `heckle_mark_ready`, and `heckle_get_fix_history`.
- MCP schemas, tool authorization/validation, and tool tests.
- Registration flow and documentation.
- Skill definition-of-done integration with regression checks.
- Registry and directory listings.

### Existing modules this feature would touch

- `apps/cli/src/cli.ts` and a new MCP command.
- `packages/daemon/src/main.ts`, `server.ts`, and `orchestrator.ts`: shared service lifecycle and verification trigger.
- `packages/memory/src/knot.ts`: open/search/history queries.
- `packages/shared/src/types.ts`: MCP-facing task and result contracts.
- `packages/delivery/src/agent-context.ts` and `.claude/skills/heckle/SKILL.md`: registration and agent workflow.
- The F1/F2 replay and verification modules.
- Prefer a separate MCP adapter module/package rather than putting protocol concerns into the widget server.

## F4. Ambient capture

**Overall: absent as a product flow. Low-level console/fetch capture is already continuous.**

### Exists today

- `installConsoleCapture()` continuously mirrors console calls into a ring buffer.
- `installFetchCapture()` continuously records fetch outcomes, including 4xx/5xx through `res.ok` and network failures through `ok: false`.
- Console and network buffers are initialized at page startup, before a user submits a heckle.
- rrweb continuously retains the recent page/event window, which can eventually seed ambient repro attempts.

### Partial

- Console calls are captured, including `console.error`, but errors are not interpreted as ambient signals.
- Failed fetches are captured, but there is no same-origin filter, configurable analytics/source-map ignore list, or ambient thresholding.
- There is no `XMLHttpRequest` instrumentation, so “XHR/fetch” coverage is incomplete.
- The widget already has a task-list UI and badge styling that could host proposals, but no ambient count or proposal state is wired.

### Absent

- `error` and `unhandledrejection` listeners for uncaught exceptions and rejected promises.
- Optional CLS, long-task, and hydration-mismatch watchers.
- Fingerprinting by message template, top stack frame, and route.
- Per-session occurrence counts and user-visible-symptom thresholds.
- Non-interrupting signal digest and `h` button count.
- Proposed tasks with synthesized repro attempts.
- Promote/dismiss UI and remembered dismissals using supersession.
- Configurable ambient ignore rules in `heckle.config.ts`.
- Signal persistence in memory.

### Existing modules this feature would touch

- `packages/capture/src/browser/buffers.ts` and a new ambient watcher/fingerprinting module.
- `packages/capture/src/browser/index.ts`: install watchers and send digest updates.
- `packages/capture/src/browser/widget.ts`: badge, digest, promote, and dismiss UI.
- `packages/shared/src/types.ts`: signal and proposal wire contracts.
- `packages/daemon/src/orchestrator.ts` and `server.ts`: thresholding, drafting, and proposal lifecycle.
- `packages/daemon/src/config.ts` and `heckle.config.ts`: ignore list and optional performance signals.
- `packages/memory/src/db.ts` and `knot.ts`: Signal records and dismiss supersession.
- F1 for repro attempts.

## F5. Instant edit lane

**Overall: partial only in the parked fastlane prototype. `main` has none of the source-edit path.**

### Exists today in the parked prototype

- High-precision, rule-first copy classification in `packages/daemon/src/fastlane/classify.ts`.
- Style requests are recognized and safely routed to the agent because no style applier exists.
- Browser-side source hints through React fiber `_debugSource`/`__source`, plus Svelte and Vue best-effort hooks, in `packages/capture/src/browser/target.ts`.
- Exact-literal source lookup by source hint, with unique-project-search fallback, in `packages/daemon/src/fastlane/locate.ts`.
- Dry-run preview, stale-position checking, project-root confinement, and conservative character checks in `packages/daemon/src/fastlane/apply.ts`.
- Human approval remains the write gate.
- Failure and ambiguity fall back to normal LLM drafting/agent delivery.
- Unit and orchestrator tests cover classification, location, apply/refusal, and fallback.

### Partial

- Text-content replacement works for one exact JSX text or quoted literal. It covers only one of five edit classes.
- `revertEdit()` exists, but the before-state is not persisted and no `heckle undo` command or widget action calls it.
- Source mapping uses fragile framework internals or a repository-wide literal search. The Vite plugin only injects the widget script and does not add `data-heckle-src`; there is no Next transform.
- The applier is single-location and conservative, but it is a positional string splice, **not an AST edit**. It does not prove that the target is JSX syntax beyond line-adjacent heuristics.
- The orchestrator reports an approved direct write as `fixed`, but does not verify HMR output or an assertion.

### Absent

- JSX-transform source attributes and the 95% React mapping target.
- Tailwind token edits, inline style edits, visibility edits, and static sibling reordering.
- AST-based codemods through ts-morph/Babel or an equivalent parser.
- Dirty-tree/dirty-parse guard, explicit logic/props/import/expression analysis, and transactional write/rollback.
- Durable undo and `heckle undo`.
- Fix memory with `authority: deterministic`.
- Repro assertion append and replay verification.
- Latency instrumentation and p50/p95 budget evidence.

### Existing modules this feature would touch

- `packages/capture/src/vite-plugin.ts` plus a Next integration: transform-time source mapping.
- `packages/capture/src/browser/target.ts`: consume `data-heckle-src` first, fiber second.
- `packages/daemon/src/fastlane/classify.ts`, `locate.ts`, and `apply.ts`: classification and codemods.
- `packages/daemon/src/orchestrator.ts`: routing, approval, fallback, verification, memory, and undo transaction creation.
- `packages/shared/src/types.ts`: edit plan, source identity, undo, and result types.
- `packages/memory/src/`: deterministic Fix records.
- `apps/cli/src/cli.ts` and an undo command.
- F1/F2 for assertions and verified completion.

## Fastlane judgment: keep the useful spine, do not merge the current write path unchanged

The thread is useful. Do **not** delete the whole thing. It proves three important pieces cheaply:

1. Rule-first classification can avoid model latency for literal copy requests.
2. Source hints plus a conservative fallback can resolve a meaningful subset of targets.
3. The approval-gated instant-to-agent fallback can fit cleanly into the existing orchestrator.

However, it should be treated as an F5 prototype, not a finished feature. The current write path violates the spec’s strongest implementation guardrail by using positional text replacement rather than AST edits. It also claims `Fixed` without F2 verification, exposes no real undo, records no deterministic Fix, appends no assertion, and jumps ahead of the spec’s P0–P2 order.

**Recommendation:** preserve `classify.ts`, the source-resolution work, the tests, and the orchestrator fallback shape. Do not merge or ship `applyLiteralEdit()` and `applyFastEdit()` as production F5 in their current form. Resume the write path in P5 after F1/F2/F6 contracts exist, replacing the splicer with an AST edit plan, persistent undo transaction, deterministic Fix record, and assertion-backed verification. If the team wants a strict milestone branch now, remove only the orchestrator integration and positional applier from the pending thread, not the research and tests.

## F6. Memory layer

**Overall: partial. The current “Knot-lite” is an issue recall table, not the 100x ledger.**

### Exists today

- Local SQLite storage under `.heckle/` through `packages/memory/src/db.ts` and `index.ts`.
- An `Issue` entity with open/fixed/recurring status, summary, flow, context reference, timestamps, and flag count.
- Local embedding-backed semantic recall through `Knot.recall()`.
- Reflag behavior: a fixed issue becomes recurring, and repeated open flags increment a counter.
- History annotations are fed back into task drafting/review.
- Local-only configuration forces local drafting and voice behavior.

### Partial

- `created_at` and `updated_at` provide ordinary lifecycle timestamps, not bitemporal history.
- `CaptureRecord` and `.heckle/captures.json` preserve a capped activity trail, but they are not Session, Repro, Fix, Element, Route, or Signal ledger entities.
- Agent completion can mark an Issue fixed, but that claim has agent/tree-change authority only and is stored as if final.

### Absent

- Repro, Fix, Session, Element, Route, and Signal entities.
- Stable Element identity through source position and testid history.
- `observed_at`, `valid_from`, and `superseded_at` records.
- Supersede-never-overwrite operations.
- Verification, human, agent, and heuristic authority classes and conflict resolution.
- Fix diffs and verified outcomes.
- Export format and schema/version migration strategy.

### Existing modules this feature would touch

- `packages/memory/src/db.ts`: schema versioning/migrations and ledger tables.
- `packages/memory/src/knot.ts`: append/supersede/query APIs and authority resolution.
- `packages/memory/src/index.ts`: repository facade and export.
- `packages/memory/src/embed.ts`: semantic indexes for relevant entities.
- `packages/shared/src/types.ts`: all ledger entities and authority/time contracts.
- `packages/daemon/src/orchestrator.ts`, `captures.ts`, and `metrics.ts`: write lifecycle facts instead of overwriting status.
- `packages/delivery/src/agent-dispatch.ts`: agent claims and fix-diff linkage.
- F1, F2, F4, and F5 as producers of Repro, Fix, Signal, Element, Route, and verification records.

## F7. Router

**Overall: partial only in the parked fastlane prototype.**

### Exists today in the parked prototype

- Deterministic regex rules distinguish literal copy, visual style, and behavioral requests in `packages/daemon/src/fastlane/classify.ts`.
- Rules inspect both verbs and literal/style values.
- Copy requests with a usable target enter the instant prototype.
- Style and behavioral requests route to normal drafting.
- Classification, location, dry-run, and apply failures fall through to the agent lane.
- The normal agent path uses the configured swappable provider, local Ollama by default.

### Partial

- The current lane vocabulary is `copy | style | behavioral`, which mixes edit type with route. The spec’s route is `instant | agent | question`, with an edit plan carried separately.
- The normal drafting model creates an agent task, but it is not a Stage 2 router that returns a single route label plus task.
- Fallback carries diagnostic information only in logs, not in the delivered task or a persisted classification record.

### Absent

- The `question` lane.
- LLM classification for rule-ambiguous utterances.
- A stable router result schema with route, confidence/reason, edit plan, and optional drafted task.
- Persisted routing decisions and latency/misroute metrics.
- A complete instant eligibility check for all five F5 edit classes.

### Existing modules this feature would touch

- `packages/daemon/src/fastlane/classify.ts`, likely promoted to a general router module.
- `packages/daemon/src/orchestrator.ts`: two-stage dispatch and carried fallback evidence.
- `packages/providers/src/types.ts`, `prompt.ts`, and provider parsing: constrained Stage 2 router output.
- `packages/shared/src/types.ts`: router result and edit plan.
- `packages/daemon/src/metrics.ts`: route share, fallback, and latency.
- F5 codemod modules.

## F8. Distribution and install

**Overall: partial. The runtime invocation exists locally, but the distribution contract does not.**

### Exists today

- A root `heckle` bin points to the CLI, and `heckle dev -- <command>` wraps a dev server.
- The dev command starts the daemon, discovers the app URL, injects the widget through a proxy, and supports an explicit app URL.
- Node 24 directly runs the TypeScript sources, so a compile step is not inherently required for a Node 24 package.
- `autoInit()` in `apps/cli/src/commands/dev.ts` installs agent context on a project’s first run.
- `heckle init --agent` can install context for Claude Code, Cursor, Codex, or all.
- Delivery checks agent binaries on PATH when selecting adapters.
- `heckle config` and the widget gear can configure a local or cloud drafting model.

### Partial

- The command shape needed by `npx heckle dev -- npm run dev` already exists, but the package is not publishable because the root and workspace package manifests are private at version `0.0.0`.
- First-run behavior teaches an agent automatically, but it is not the required wizard and defaults to Claude Code unless directed.
- The local daemon serves a script at `/heckle.js`, and the proxy can inject it into a local app. This is not remote capture-only mode or a CDN asset.
- A Claude skill exists in the repository and can be installed into projects. It is not a marketplace package and contains no MCP workflow.

### Absent

- Published npm package, package file allowlist, release/version process, and validated fresh-machine `npx` install path.
- README install story using `npx`; it still instructs users to clone, install, and link.
- Interactive detection of Ollama availability, model readiness/pull, available agents, and provider-key alternatives.
- MCP registration offer.
- Activation validation for zero-to-first-heckle under three minutes.
- Claude marketplace and MCP directory publishing.
- Hosted `h.js`, project identity, encrypted opt-in relay or local export, and remote capture-only semantics.

### Existing modules this feature would touch

- Root `package.json`, workspace manifests, lockfile, and release automation.
- `apps/cli/bin/heckle.ts`, `src/cli.ts`, and `src/commands/dev.ts`: packaged path resolution and first-run entry.
- `apps/cli/src/commands/config.ts` and a new onboarding command/module.
- `packages/daemon/src/config.ts`: detected defaults and readiness checks.
- `packages/delivery/src/agent-context.ts` and adapter discovery.
- `README.md`, `docs/getting-started.md`, and `docs/run-on-your-project.md`.
- F3 MCP registration.
- `packages/capture/src/loader.js`, browser transport, and daemon ingestion for capture-only mode.
- New relay/export and project-auth components for F8.4.

## F9. Team layer

**Overall: absent, including the “design now” data-model primitives.**

### Exists today

- Local issue IDs and capture timestamps provide a base on which provenance could be added.
- The delivery architecture already separates a browser reporter surface from a daemon that ships to an agent, but only on one local machine and without roles.

### Partial

- None of the required team contracts are implemented. The current physical separation is an architectural hint, not a team feature.

### Absent

- Shared ledger and sync.
- Reporter and shipper roles.
- Multiple reporters feeding one shipper.
- Issue owner and source fields.
- Default `owner: local` and `source: local` values from day one.
- Reporter identity, project membership, authorization, assignment, and provenance queries.
- Capture-only script-tag reporter flow from F8.4.

### Existing modules this feature would touch

- `packages/shared/src/types.ts`: reporter, owner, source, role, and project identity.
- `packages/memory/src/db.ts` and `knot.ts`: provenance fields, assignment, and shared-ledger operations.
- `packages/daemon/src/orchestrator.ts` and `server.ts`: reporter ingestion and shipper authority.
- `packages/capture/src/browser/transport.ts`, `index.ts`, and widget UI: reporter identity and capture-only behavior.
- `packages/delivery/`: shipper-only approval and dispatch enforcement.
- F8.4 relay/export components.

## Recommended sequence from this audit

1. **P0 first:** make the existing CLI genuinely installable with `npx`, replace clone/link docs, and add the first-run readiness flow.
2. **F1 contract before more capture cleverness:** define and persist versioned repro artifacts, then build replay and determinism.
3. **F2 immediately after F1:** stop equating changed files with fixed behavior.
4. **F6 schema before F3/F4/F5 completion:** add the minimum ledger entities, bitemporal fields, authority, owner, and source so later features do not create throwaway stores.
5. **F3 and F4 on those contracts.**
6. **Return to F5/F7:** reuse the fastlane classifier and source-resolution research, but ship only AST-backed, undoable, memory-recorded, replay-verified edits.
7. **F8.4/F9 last, while preserving owner/source fields from the F6 migration onward.**

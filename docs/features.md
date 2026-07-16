# Heckle features

This document describes the feature set on `main` for Heckle v0.1.0. Heckle is a local QA co-pilot that captures what happened in an app, turns a spoken or typed complaint into a structured task, delivers approved work to a coding agent, and verifies the result through replay.

## Core QA loop

- Run an app through Heckle with `npx heckle-dev dev -- <command>`.
- Open the in-app widget with the launcher or `Cmd/Ctrl+Shift+.`.
- Describe a problem by typing or voice.
- Capture the route, selected element, recent actions, console output, network activity, viewport, browser state, and rrweb events.
- Draft a structured task with severity, target, repro steps, evidence references, and assertions.
- Let the user review or edit the task before delivery.
- Deliver only after explicit approval. This is a hard gate.
- Show agent progress and verify the resulting fix before marking the issue Fixed.

## Capture and targeting

Heckle continuously keeps bounded local buffers so a report includes the events that led to it rather than only the final screen.

Captured context includes:

- Page URL and route.
- Typed actions for navigation, clicks, fills, key presses, selects, and checks.
- Console messages and stack information.
- Fetch and XMLHttpRequest metadata, failures, and redacted request or response data when available.
- Viewport, local storage, session storage, and cookie state seeds.
- Recent rrweb events.
- Highlighted text and the last pointed element.
- Stable target fallbacks in this order: test id, accessible role and name, then CSS.
- Best-effort source locations for supported React development builds.

Sensitive key, token, password, credential, session, cookie, authorization, and email values are redacted before repro artifacts are stored.

## Drafting and privacy

- Local-first drafting through Ollama, using `qwen3:14b` by default.
- Anthropic support and support for OpenAI-compatible providers such as DeepSeek, OpenAI, Groq, OpenRouter, and local compatible servers.
- CLI and widget configuration for provider, model, endpoint, voice, delivery agent, session mode, and autonomy.
- Masked API keys in configuration output.
- `privacy.localOnly = true` forces local drafting, local voice behavior, and local memory.
- Cloud drafting explicitly turns local-only mode off because captured context leaves the machine.
- Local SQLite storage and local embedding-backed issue recall.
- Local activation and retention metrics with no remote telemetry.

Voice providers are local OS dictation, browser Web Speech, and Deepgram. Typing works across macOS, Windows, and Linux. The current on-device voice path is macOS-focused.

## Human approval and agent delivery

Nothing reaches a coding agent until the user approves the drafted task.

Supported delivery paths are:

- Claude Code, with fresh or Heckle-owned persistent sessions and configurable tool permissions.
- Cursor Agent, with fresh or persistent sessions and guarded headless edits.
- Codex CLI, with fresh or continued sessions and configurable sandbox behavior.
- `.heckle/inbox.md`, which is always written as the durable fallback.
- Clipboard as the final fallback.

`heckle init --agent <agent>` installs Heckle workflow context for Claude Code, Cursor, Codex, or all supported agents. First-run `heckle dev` can install this context automatically.

## Repro artifacts

Every approved report can become a versioned artifact under `.heckle/repros/` containing:

- Origin, route, viewport, and browser state seed.
- Typed actions and stable targets.
- Redacted network fixtures.
- Assertions.
- The original utterance.
- Surface mappings to routes, files, and elements when known.
- Determinism and verification outcomes.

Supported assertions include:

- Text equality.
- Attribute presence and substring matching.
- Computed style equality.
- Child text order.
- Clean console levels.
- No unexpected failed requests.

## Replay and determinism

`heckle replay <repro-id>` uses Playwright and Chromium to replay a captured complaint.

- Recorded network fixtures are used by default.
- `--live` uses live endpoints instead.
- `--headed` shows the browser.
- `--runs <count>` overrides the run count.
- `--url <origin>` overrides the captured origin.
- Replay returns assertion-level expected and observed results.
- Three runs are used by default as the determinism gate.
- Any failed gate run quarantines the repro instead of promoting an unstable test.

## Fix verification and regressions

A file change or successful agent process is not sufficient evidence that a problem is fixed.

- Heckle runs the associated repro twice after a fix is ready.
- Both runs must pass before the issue is marked Fixed.
- A failure records assertion deltas and can trigger one evidence-backed retry.
- Verified repros are promoted into the local regression suite.
- `heckle test` runs all promoted repros and exits non-zero on regression.
- `heckle test --changed` selects repros using changed files and recorded source mappings.
- Unmapped repros run conservatively until source mappings are available.
- Unstable repros are reported as quarantined rather than silently ignored.

## Ambient QA

Heckle can notice failures before the user files a report.

It observes:

- Console errors.
- Uncaught exceptions.
- Unhandled promise rejections.
- Same-origin failed fetch requests and HTTP 4xx or 5xx responses.
- Optional CLS, long-task, and hydration signals, which are disabled by default.

Signals are normalized and deduplicated by message shape, route, and top frame. Repeated signals become quiet proposals after a threshold, while a failed request immediately following a click can propose on the first occurrence. The widget shows a proposal count without interrupting the user. A proposal can be promoted into the normal approval flow or dismissed persistently. `ambient.ignore` suppresses app-specific endpoints.

## Instant edits

Safe, obvious React literal changes can bypass a full agent round trip while retaining the approval gate.

The instant lane supports five AST-guarded edit classes:

- JSX text and string literals.
- Tailwind class tokens.
- Inline style values.
- Static visibility through the `hidden` attribute.
- Static sibling reordering.

Vite and Next.js integrations map rendered JSX to source files in development. The editor is intentionally conservative. Dynamic expressions, logic, imports, props, ambiguous locations, stale source, and failed parse guards fall back to the normal agent lane. Successful edits record a deterministic Fix, add a replay assertion, and save a stale-safe undo transaction. `heckle undo` restores the latest instant edit only when the file still matches the recorded result.

## Routing

A rule-first router chooses among:

- `instant` for eligible literal edits.
- `agent` for behavioral, structural, dynamic, or ambiguous work.
- `question` for requests that should be answered rather than applied as code changes.

Instant-lane classification, source resolution, or edit failures fall back safely to the agent lane. A model-classification hook exists for ambiguous requests, but no provider-backed classifier is wired in v0.1.0.

## Local memory and ledger

Heckle stores a versioned SQLite ledger under `.heckle/` with:

- Issues.
- Repros.
- Fixes.
- Sessions.
- Elements.
- Routes.
- Signals.
- Team members.

Records carry observed, valid-from, and superseded timestamps. Updates supersede prior facts rather than erasing history. Authority classes distinguish verification, human, deterministic, agent, and heuristic claims. Issues retain ownership, source, status, severity, and provenance. Semantic recall helps detect repeated or recurring reports. `heckle export [file]` exports the ledger as versioned JSON.

## MCP agent interface

`heckle mcp` serves seven local tools over stdio:

- `heckle_list_open`: list open issues by route or severity.
- `heckle_get_task`: retrieve a task with evidence, receipt, and repro reference.
- `heckle_search_memory`: search issue and fix history.
- `heckle_check_regressions`: select and optionally run regressions for changed files.
- `heckle_run_repro`: run one repro and return assertion evidence.
- `heckle_mark_ready`: trigger two-run verification for an issue.
- `heckle_get_fix_history`: inspect fixes for an element or route.

The MCP server reads the current project's local `.heckle/` data. It has no hosted transport or remote ledger.

## Capture-only and team workflow

A non-technical reporter can use the capture-only script on a staging site without installing the CLI or gaining source or agent access.

- The widget exports a `heckle-capture@1` JSON file.
- Exported data contains the task, route, action steps, and redacted error metadata.
- It excludes source code, DOM content, cookies, credentials, and network bodies.
- `heckle import <file>` validates size, schema, identifiers, origin, timestamp, and evidence limits.
- Import preserves the reporter as owner and `capture-only` as source.
- Import writes the local queue but never starts an agent.
- The shipper still reviews, approves, and verifies the work.
- Reporter and shipper roles are stored in the ledger.

## CLI commands

```text
heckle dev [opts] -- <command>  Run an app with Heckle attached
heckle init [--agent <agent>]   Install agent workflow context
heckle config [...]             Configure model, voice, keys, and settings
heckle replay <id> [...]        Replay a repro
heckle test [--changed ...]     Run promoted regressions
heckle mcp                      Start the local MCP server
heckle undo                     Undo the latest instant edit
heckle import <file>            Import a capture-only report
heckle export [file]            Export the local ledger
heckle metrics                  Show local activation and retention metrics
heckle version                  Print the installed version
```

## Readiness and distribution

- Zero-install startup through `npx heckle-dev dev -- <command>`.
- Node 24 or newer is required.
- Startup checks Node, configured model readiness, coding agents, local ports, and Playwright Chromium.
- A missing Ollama model can be pulled from the interactive readiness prompt.
- Non-interactive checks fail with an actionable setup command instead of waiting.
- The package exports Vite, Next.js, capture-only, and source-loader entry points.

## Current boundaries

The following are not part of v0.1.0:

- A Heckle-hosted CDN for the capture-only script.
- A hosted relay or synchronized multi-user ledger.
- Hosted authorization and assignment workflows for teams.
- MCP marketplace or external directory distribution.
- A provider-backed second-stage classifier for ambiguous routing.
- Next.js Turbopack source transforms. The current Next integration uses the Webpack loader path.
- Selective or multi-level instant-edit undo.
- Automatic fixture freshness detection and refresh.

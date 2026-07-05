# Run Heckle on your own project

Heckle attaches to any local web app in dev. You test the app, flag what is broken by voice
or text, approve the draft, and your coding agent fixes it. This guide gets Heckle running on
a project other than this repo.

## One-time setup

Prerequisites:
- **Node 24+** (runs the TypeScript directly, no build step).
- **Ollama** running with the drafting + embedding models pulled (the local-first default):
  `ollama pull qwen3:14b && ollama pull nomic-embed-text`
- Optional: **Claude Code** (`claude` on your PATH) for auto-dispatch (approve then the fix kicks off).
- Optional voice (macOS): the local Parakeet worker, built once in this repo with
  `npm run stt:build`. Voice is optional; you can always type.

Make the `heckle` command available from anywhere:

```bash
# in the Heckle repo
npm install
npm link          # puts `heckle` on your PATH (symlinked to this repo)
```

If `npm link` gives you trouble, skip it and call Heckle by path from your project:
`node /absolute/path/to/heckle/apps/cli/bin/heckle.ts <args>`.

## Per project

From your project's root, just run your dev server under Heckle:

```bash
heckle dev -- npm run dev        # or: heckle dev -- pnpm dev, next dev, vite, etc.
```

On the **first run** Heckle automatically teaches your agent about itself (writes the inbox
convention + a `/heckle` skill to your project) so "check Heckle" and auto-dispatch just work. No
separate step. Options: `--agent <claude-code|cursor|codex|all>` to target a specific agent,
`--no-init` to skip. To teach more agents later (or up front), run `heckle init --agent all`
(adds AGENTS.md for Codex and .cursorrules for Cursor alongside the Claude Code skill).

That is it, no project changes. Heckle runs your dev server, finds its URL from the output,
and stands up an injecting proxy in front of it. It prints:

```
[heckle] Open your app with Heckle at:  http://localhost:4318
```

Open that URL (not your usual dev URL). The launcher (the "h") is bottom-right; a green dot
means connected. HMR passes straight through the proxy.

Flags: `--ui-port <n>` changes the proxy port, `--app-url <url>` if Heckle cannot find the dev
URL from the output, `--no-proxy` opts out (then inject the widget yourself, below).

<details>
<summary>Prefer no proxy? Inject the widget yourself</summary>

Run with `--no-proxy` and add the widget to your app (dev only). Universal, any framework:

```html
<script src="http://127.0.0.1:4317/heckle.js"></script>
```

Or, for Vite, the plugin (when `@heckle/capture` is resolvable in your project):

```ts
// vite.config.ts
import heckle from "@heckle/capture/vite-plugin";
export default { plugins: [heckle()] };
```
</details>

## The loop

1. Use your app. Heckle silently records clicks, DOM, console, and network in a rolling buffer.
2. When something is off, open the widget (or use the talk hotkey), say or type what is wrong, Capture.
3. Heckle drafts structured feedback with the receipts attached. Review it.
4. Ship it to the agent. With Claude Code on your PATH it dispatches automatically; otherwise the
   item is written to `.heckle/inbox.md` and you tell your agent "check Heckle" (the skill from
   step 1 handles it).

## How the fix reaches Claude Code

You cannot pipe an approved fix into the interactive `claude` session you have open in a terminal,
there is no such API. So Heckle runs the fix as its own headless Claude Code process and, by
default, keeps it in **one persistent conversation** it owns (the id is stored in
`.heckle/claude-session-id`). Every approved fix appends to that same session, so fix N can see
fixes 1..N-1. It logs to `.heckle/dispatch-<id>.log`, with `--permission-mode acceptEdits` (your
approval was the gate) plus an allowlist so it can run your tests.

While the fix runs, its row in the widget shows one live line of what the agent is doing ("Editing
Hero.tsx", "Running a check") plus elapsed time. When it finishes, the row reads **Fixed** (reload
to see it) or **Didn't land**. "Fixed" means the code on disk actually changed, so a reload shows
it. It is decided by the working tree changing, not the agent's exit code: an agent that edits your
files correctly but then fails its own self-check (a blocked command, a failing test) still reads as
Fixed, because the fix is really there. If you route to "Inbox only", the row just says the item was
saved to `.heckle/inbox.md`, since no agent was dispatched.

You can change this live from the widget's settings gear (the "Delivery" section): pick which agent
fixes (Claude / Cursor / Codex / Inbox only), whether the session is Persistent or Fresh, and the
Autonomy level. The gear remembers your choice per project (localStorage, keyed by the project the
daemon serves) and applies it to that project's daemon on connect, so it survives reloads and
restarts without leaking into your other Heckle projects. The `heckle.config.ts` values below are
the defaults the gear starts from; the gear does not rewrite that file, and knobs the gear does not
own (like a custom `delivery.order` tail or `cursor.force`) are left as you configured them. For
Codex the gear's Persistent cannot mint an owned session (Codex has no client-supplied id), so
accumulation stays a config-only opt-in (`codex.session: "continue"`).

Nothing to set up: it just works once `claude` is on your PATH. Tune the defaults in
`heckle.config.ts` under `delivery.claudeCode`:

- `session`: `"persistent"` (default, context accumulates) · `"fresh"` (new context per fix) · a
  pinned UUID.
- `permissionMode`: `"acceptEdits"` (default) · `"bypassPermissions"` (full autonomy) · etc.
- `allowedTools`: which commands a fix may run unprompted. Omit for edits-only.

Prefer to review each fix yourself? Set `delivery.order` to `["file-inbox", "clipboard"]` (drop
the agent). Then approvals just land in `.heckle/inbox.md` and you run "check Heckle" in your
own live `claude` session when ready, so the fix uses that session's context and you watch it.

### Using Cursor or Codex instead of Claude Code

Swap the agent in `delivery.order`, e.g. `["cursor", "file-inbox", "clipboard"]` or
`["codex", ...]`. Same idea, each runs its own headless CLI with its own per-project session:

- **Cursor** (`cursor-agent`): install from `cursor.com/install`, set `CURSOR_API_KEY` in `.env`.
  Heckle runs `cursor-agent -p --force` and, for `session: "persistent"` (default), mints an owned
  chat via `create-chat` (kept in `.heckle/cursor-session-id`) and `--resume`s it so fixes
  accumulate. `--force` is required for edits to land in headless mode.
- **Codex** (`codex`): `npm i -g @openai/codex`, set `CODEX_API_KEY` in `.env`. Heckle runs
  `codex exec --sandbox workspace-write --ask-for-approval never`. Codex has no client-supplied
  session id, so `session` is `"fresh"` (default, new each fix) or `"continue"` (resume the newest
  session in this dir, which accumulates but can collide with your own codex sessions there).

Multiple apps stay isolated automatically: the session lives in each app's own `.heckle/`, and
each dispatch runs in that app's directory. To run Heckle on two apps at once, give the second
different ports (`HECKLE_PORT` / `--ui-port`).

## Configure the drafting model (CLI or the widget gear)

No config is needed for the local default (Ollama `qwen3:14b`). To change the model, or point it at
a cloud provider, use either of these (no file editing). Both write `~/.heckle/config.json`, set
once and applied to every project (`$HECKLE_CONFIG_DIR` relocates it).

**Any model works.** Ollama (local) and Claude are built in; every other provider is reached as an
OpenAI-compatible endpoint (OpenAI, DeepSeek, OpenRouter, Groq, Together, Mistral, a local LM Studio
/ vLLM / llama.cpp server, ...), so you just point it at a base URL + model + key. Nothing to code.

From the command line:

```bash
heckle config                              # show the current model / voice / keys (keys masked)
heckle config model deepseek deepseek-chat # a preset (this turns local-only OFF)
heckle config key deepseek <api-key>       # store the key (as DEEPSEEK_API_KEY)
# any other provider: give it a base URL; the key is stored as <PROVIDER>_API_KEY
heckle config model groq llama-3.3-70b https://api.groq.com/openai/v1
heckle config key groq <api-key>
heckle config model ollama qwen3:14b       # back to the local model
heckle config voice webspeech              # or: local
```

Or from the widget: open the gear, the **Model** section, pick the provider (Ollama / DeepSeek /
OpenAI-compat / Claude), type the model name, a Base URL (for OpenAI-compat, point it at any such
endpoint), and the API key, then Save. The daemon rebuilds the model live, no restart. Choosing a
cloud model turns off local-only, so your captured console/network context is sent to that provider;
keep Ollama if you want nothing to leave the machine.

Power users can still add a `heckle.config.ts` to the project root (merged under the user layer)
for the full shape; see this repo's `heckle.config.ts`.

## Notes

- Everything is loopback-only and, by default, no egress.
- `.heckle/` (inbox, metrics, last-trigger) is written in your project root; add it to `.gitignore`.
- The daemon uses port 4317 by default; set `HECKLE_PORT` to change it (also update the script tag).

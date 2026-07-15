# Getting started with Heckle

Heckle is a QA co-pilot for your app. While you use your app, you say or type what looks wrong.
Heckle turns it into a clear task (with the console and network details attached) and your coding
agent fixes it. You approve every fix before anything happens.

This guide gets you from nothing to running in a few minutes.

Works on macOS, Windows, and Linux. Typing works on all three; on-device voice is macOS only for now.

## What you need

- **Node 24 or newer.** Get it from [nodejs.org](https://nodejs.org), or install with a package manager:
  - macOS: `brew install node`
  - Windows: `winget install OpenJS.NodeJS`
  - Linux: `nvm install 24` (see [nvm](https://github.com/nvm-sh/nvm)), or your distro's package
  - Check with `node --version` (should be v24 or higher).
- **A model for Heckle to write with.** Pick one:
  - **Local and free:** install [Ollama](https://ollama.com). Heckle checks the configured model on
    startup and offers to pull it when missing.
  - **A cloud model** you already have a key for (OpenAI, DeepSeek, Gemini, Groq, and others work).
- **Optional: a coding agent** to apply fixes automatically:
  - [Claude Code](https://code.claude.com/docs), [Cursor](https://cursor.com/install)
    (`cursor-agent`), or Codex (`npm install -g @openai/codex`).
  - Without one, every approved task is written to `.heckle/inbox.md`.

## 1. Run your app with Heckle

From your project's root, put `npx heckle-dev dev --` in front of the command you normally use:

```bash
npx heckle-dev dev -- npm run dev
```

No Heckle clone, global installation, link, or project configuration is required. The package is
named `heckle-dev`; a global installation exposes the shorter `heckle` command.

On first run Heckle checks:

- Node is version 24 or newer.
- The daemon and UI ports are available.
- Ollama is reachable and the configured model is present. In a terminal, it offers to pull a
  missing model.
- Which of Claude Code, Cursor, and Codex are on PATH.
- Whether automatic agent delivery is available or the file inbox fallback will be used.

Non-interactive runs never wait for a prompt. They fail with the exact setup command needed. After
explicitly configuring drafting another way, `--skip-model-check` can bypass only the Ollama check.

Open the link Heckle prints (something like `http://localhost:4318`). Your app looks the same, with a
small **h** button in the corner.

## 2. Choose a different drafting model

The default is local Ollama with `qwen3:14b`. To use a cloud model, configure it before `dev`:

```bash
npx heckle-dev config model deepseek deepseek-chat
npx heckle-dev config key deepseek <your-api-key>
```

For any OpenAI-compatible provider, supply its model and base URL. Run `npx heckle-dev config` to see
the effective settings; keys are masked. Cloud drafting sends captured context to that provider and
turns local-only mode off. Ollama keeps capture and drafting on your machine.

## 3. Use it

1. Click the **h** button, or press **Cmd/Ctrl+Shift+.** to talk.
2. Say or type what is wrong.
3. Heckle writes a clear task. Read it, **Edit** it if you want to change the wording, then click
   **Ship to agent**.
4. If you have a coding agent connected, it fixes it and the task shows **Fixed**. Reload your app to
   see the change.
5. If you do not, the task is saved to `.heckle/inbox.md`. Open your own agent and say "check Heckle,"
   or click **Run it with the agent** on the task.

That is the whole loop: notice something, say it, approve, done.

## Replay the complaint

The approved task includes a repro id. Run it against the local app while the dev server is up:

```bash
npx heckle-dev replay <repro-id>
```

Heckle replays it three times in headless Chromium using recorded network fixtures. Add `--live` to
hit real endpoints, `--headed` to watch the browser, or `--url <origin>` to override the captured
origin. Mixed outcomes are quarantined rather than silently promoted. If Chromium is absent, run
`npx playwright@1.61.1 install chromium` once.

## Which coding agent fixes it?

- **Claude Code, Cursor, or Codex**: fully automatic. Approve a task and it runs, with live progress
  and a Fixed / Didn't-land result. Pick which one in the gear under Delivery.
- **Any other agent**: use "Inbox only" in the gear. Heckle writes the task to `.heckle/inbox.md`;
  you point your agent at it. Works with anything that can read a file and edit code.

## Handy commands

```bash
npx heckle-dev config              # show the current model, voice, and keys (keys masked)
npx heckle-dev config model ...    # change the model (see step 2)
npx heckle-dev config voice local  # voice input: local (macOS) or webspeech (Chrome)
npx heckle-dev dev -- <command>    # run your app with Heckle attached
npx heckle-dev replay <repro-id>   # replay an approved complaint three times
npx heckle-dev help                # all commands
```

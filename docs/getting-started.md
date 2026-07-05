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
  - **Local and free:** install [Ollama](https://ollama.com) and run `ollama pull qwen3:14b`. Nothing
    leaves your machine.
  - **A cloud model** you already have a key for (OpenAI, DeepSeek, Gemini, Groq, and others all work).
- **Optional: a coding agent** to apply fixes automatically:
  - [Claude Code](https://code.claude.com/docs), or [Cursor](https://cursor.com/install) (`cursor-agent`),
    or Codex (`npm install -g @openai/codex`).
  - Without one, Heckle writes the task to a file and you point your own agent at it.

## 1. Install

```bash
git clone <the Heckle repo>
cd heckle
npm install
npm link
```

That gives you a `heckle` command you can run from any of your projects.

## 2. Choose the model Heckle writes with

You can do this from the command line, or later from the gear icon in the Heckle panel (no terminal
needed). From the command line:

**Local and free:**
```bash
heckle config model ollama qwen3:14b
```

**A cloud model** (any provider that speaks the common OpenAI format works: OpenAI, DeepSeek, Gemini,
Groq, OpenRouter, and more). Give it the model name, the provider's base URL, and your key:
```bash
# OpenAI
heckle config model openai gpt-4o-mini https://api.openai.com/v1
heckle config key openai <your-api-key>

# DeepSeek
heckle config model deepseek deepseek-chat
heckle config key deepseek <your-api-key>

# Google Gemini
heckle config model gemini gemini-2.0-flash https://generativelanguage.googleapis.com/v1beta/openai
heckle config key gemini <your-api-key>
```

Run `heckle config` any time to see what is set (your key is shown masked). A cloud model means your
captured page context is sent to that provider; keep Ollama if you want everything to stay on your
machine.

## 3. Run your app with Heckle

In your project, put `heckle dev --` in front of the command you normally use to start it:

```bash
heckle dev -- npm run dev        # or: heckle dev -- pnpm dev, yarn dev, vite, next dev, ...
```

Open the link Heckle prints (something like `http://localhost:4318`). Your app looks the same, with a
small **h** button in the corner.

## 4. Use it

1. Click the **h** button, or press **Cmd/Ctrl+Shift+.** to talk.
2. Say or type what is wrong.
3. Heckle writes a clear task. Read it, **Edit** it if you want to change the wording, then click
   **Ship to agent**.
4. If you have a coding agent connected, it fixes it and the task shows **Fixed**. Reload your app to
   see the change.
5. If you do not, the task is saved to `.heckle/inbox.md`. Open your own agent and say "check Heckle,"
   or click **Run it with the agent** on the task.

That is the whole loop: notice something, say it, approve, done.

## Which coding agent fixes it?

- **Claude Code, Cursor, or Codex**: fully automatic. Approve a task and it runs, with live progress
  and a Fixed / Didn't-land result. Pick which one in the gear under Delivery.
- **Any other agent**: use "Inbox only" in the gear. Heckle writes the task to `.heckle/inbox.md`;
  you point your agent at it. Works with anything that can read a file and edit code.

## Handy commands

```bash
heckle config              # show the current model, voice, and keys (keys masked)
heckle config model ...    # change the model (see step 2)
heckle config voice local  # voice input: local (macOS) or webspeech (Chrome)
heckle dev -- <command>    # run your app with Heckle attached
heckle help                # all commands
```

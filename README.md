# Heckle

**just say what's wrong. your agent fixes it.**

Heckle is a QA co-pilot for building apps with AI agents. You use your app like a normal person,
and the second something looks off, you just say it (or type it). Heckle turns your words into a
clear task with the console and network details attached, hands it to your coding agent, and waits
for your ok before anything happens. No screenshots. No pasting errors. No writing a paragraph
explaining what you just saw.

![Heckle in action: say what's wrong, and it ships the fix to your coding agent](assets/heckle-demo.gif)

**The full walkthrough, with sound:**

https://github.com/user-attachments/assets/90c4477c-784a-49dc-96f6-b2d280018e9f

## why i built this

I build apps with AI agents, and the worst part was the loop. The agent writes the code and then
goes blind the moment I actually use the app. So I would screenshot the bug, paste it back, and type
out what I saw, fifty times a day. I got tired of being a human screen reader for a machine that
should just be watching. So now I talk to my app and my agent fixes it.

## what makes it not annoying

- You talk, you do not fill out a bug report. Say it the way you would say it to a person.
- It grabs the receipts for you: the DOM, the console errors, the network calls, the exact path you
  took. Your agent stops guessing.
- Nothing ships without your ok. Heckle drafts, you read, you hit send. No autonomous chaos.
- You watch it work. After you ship, the task shows a live line of what the agent is doing, then
  lands on Fixed or Didn't land, decided by whether your code actually changed, not a hopeful guess.
- It remembers. What you flagged, what got fixed, what is still open. You never explain the same bug
  twice.
- It is yours and it is private. Runs on your machine, on a local model by default. Nothing leaves.

## what it needs

Runs on macOS, Windows, and Linux, it is plain Node so the core is cross-platform. Built and tested
on a Mac; Linux should be fine; Windows should run too. Typing works everywhere; on-device voice is
Mac-only for now, type on the others.

- **Node 24 or newer.** Get it from [nodejs.org](https://nodejs.org), or `brew install node` (mac),
  `winget install OpenJS.NodeJS` (windows), `nvm install 24` (linux). Check with `node --version`.
- **A model to think with.** Either local and free with [Ollama](https://ollama.com)
  (`ollama pull qwen3:14b`, wants ~16GB RAM; use `llama3.1:8b` on a smaller machine), or a cloud key
  you already have (OpenAI, DeepSeek, Gemini, Groq, anything OpenAI-compatible).
- **A coding agent, optional.** [Claude Code](https://code.claude.com/docs),
  [Cursor](https://cursor.com/install), or Codex (`npm install -g @openai/codex`). Without one,
  Heckle writes the fix to a file and you hand it to whatever you use.

## install

```bash
git clone <this-repo-url>
cd heckle
npm install
npm link
```

That gives you a `heckle` command in any project. (If `npm link` gives you trouble, the
[getting started guide](docs/getting-started.md) has a no-link fallback.)

## pick your model

```bash
heckle config model ollama qwen3:14b        # local and free
# or a cloud model:
heckle config model deepseek deepseek-chat
heckle config key deepseek <your-api-key>
```

Or set it from the gear inside the panel. `heckle config` shows what is set (your key stays hidden).

## run it

```bash
heckle dev -- npm run dev      # or pnpm dev, vite, next dev, whatever you use
```

Open the link it prints (like `http://localhost:4318`). Your app looks the same, with a small **h**
button in the corner.

## how you use it

1. Click the **h** button, or press **Cmd/Ctrl+Shift+.** to talk.
2. Say what is wrong: "the total does not update when I change the quantity."
3. Read the task, edit the wording if you want, hit **Ship to agent**.
4. With an agent connected, it fixes it while you watch, then says **Fixed**. Reload to see it.
5. Without one, the task waits in a file. Tell your agent to "check Heckle," or hit **Run it** on the
   task.

## which agent fixes it

Claude Code, Cursor, and Codex fix automatically, pick one in the gear. Anything else picks the task
up from a file, so it works with whatever you build with.

## more

Step by step in [docs/getting-started.md](docs/getting-started.md).

## credits

Sriram ([@rbsriram](https://github.com/rbsriram)) and Claude Code. Sriram had the idea and made every
call. Claude did a lot of the typing.

MIT. Use it, fork it, build on it.

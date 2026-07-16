import type { HeckleConfig } from "@heckle/shared"

// Heckle v0 ships LOCAL-FIRST defaults on this machine:
//   - drafting  -> Ollama (qwen3:14b), OpenAI-compatible endpoint, no key, no egress
//   - voice     -> "local": you dictate into the always-available text field with your
//                  own OS dictation (TypeWhisper + Parakeet). Heckle never ships audio anywhere.
//   - memory    -> local SQLite + local embeddings (nomic-embed-text via Ollama)
//
// Every layer is swappable by editing this file. Secrets stay in .env (daemon-only):
//   - drafting.provider "deepseek"  needs DEEPSEEK_API_KEY   (model deepseek-v4-flash)
//   - drafting.provider "anthropic" needs ANTHROPIC_API_KEY  (Claude, for production quality)
//   - voice.provider    "deepgram"  needs DEEPGRAM_API_KEY   (cloud streaming STT)
//
// Do NOT use deepseek-chat / deepseek-reasoner: they retire 2026-07-24.
const config: HeckleConfig = {
  drafting: {
    provider: "ollama", // ollama | deepseek | anthropic
    model: "qwen3:14b",
    baseUrl: "http://localhost:11434/v1",
  },
  voice: {
    provider: "local", // local (OS dictation, e.g. TypeWhisper+Parakeet) | webspeech | deepgram
  },
  delivery: {
    // Tried in order on approve; the file inbox is always written as the durable floor. Pick
    // your agent here: swap "claude-code" for "cursor" or "codex" to route fixes there instead.
    // For "inbox-pull" (no background fix, you run "check Heckle" in your own agent session),
    // drop the agent: order: ["file-inbox", "clipboard"].
    order: ["claude-code", "file-inbox", "clipboard"],
    // How approved fixes reach each agent (headless). Sensible defaults live in the daemon;
    // override only what you want. You cannot pipe into your OPEN interactive session (no such
    // API for any of them), so Heckle owns its own per-project conversation instead.
    claudeCode: {
      // "persistent" (default): one owned session (id kept in .heckle/claude-session-id) so a
      // fix sees earlier fixes. "fresh": new context each time. Or pin an explicit UUID.
      session: "persistent",
      // acceptEdits lets edits land unprompted (approval was the gate). Use "bypassPermissions"
      // for full autonomy, or drop allowedTools below for edits-only.
      permissionMode: "acceptEdits",
      // Commands the fix may run without a prompt (so it can verify itself). Tune for your
      // project's runner. Omit to let it edit files but not run anything.
      allowedTools: ["Edit", "Write", "Read", "Bash(npm test:*)", "Bash(npm run build:*)"],
    },
    // Cursor (`cursor-agent`): "persistent" mints an owned chat (create-chat) so fixes
    // accumulate; --force lets edits land in headless mode. Auth via CURSOR_API_KEY in .env.
    cursor: { session: "persistent", force: true },
    // Codex (`codex exec`): no client-supplied id, so "fresh" (default) or "continue" (resume
    // the newest session in this dir). Sandbox lets it edit + run tests. Auth via CODEX_API_KEY.
    codex: { session: "fresh", sandbox: "workspace-write", askForApproval: "never" },
  },
  agent: "claude-code",
  memory: {
    embedProvider: "ollama", // ollama | fastembed
    embedModel: "nomic-embed-text",
  },
  privacy: {
    localOnly: true, // true = hard no-egress: forces local voice + local model + local memory
  },
  ambient: {
    ignore: ["analytics", "source-map", "sourcemap", "favicon.ico"],
    performance: { cls: false, longTasks: false, hydration: false },
  },
}

// To switch drafting to DeepSeek (faster, cloud): put your key in .env as DEEPSEEK_API_KEY,
// then replace the `drafting` + `privacy` blocks above with:
//
//   drafting: { provider: "deepseek", model: "deepseek-v4-flash", baseUrl: "https://api.deepseek.com" },
//   privacy:  { localOnly: false },   // required, DeepSeek is cloud egress
//
// (localOnly:true hard-forces Ollama, so it must be false to use any cloud provider.)

export default config

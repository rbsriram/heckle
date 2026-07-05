// Core shared types for Heckle. Pure types only, zero runtime, safe to import anywhere,
// including before any third-party dependency is installed.

// ---------- Configuration ----------

// "ollama" (local) and "anthropic" (Claude) are handled specially; ANY other name is treated as an
// OpenAI-compatible endpoint (deepseek, openai, openrouter, groq, together, mistral, local LM Studio
// / vLLM / llama.cpp, ...), reached at drafting.baseUrl with a key from <PROVIDER>_API_KEY. The
// `(string & {})` keeps the known names as hints without closing the set.
export type DraftingProvider = "ollama" | "anthropic" | "deepseek" | (string & {});
export type VoiceProvider = "local" | "webspeech" | "deepgram";
export type EmbedProvider = "ollama" | "fastembed";
export type AgentTarget = "claude-code" | "cursor" | "codex" | "none";
export type DeliveryAdapterName = "claude-code" | "cursor" | "codex" | "file-inbox" | "clipboard";

// The high-level dispatch choice the widget settings gear controls, mapped by the daemon onto
// the per-agent delivery config. "inbox" = no auto-dispatch (write the inbox, pull it yourself).
export type DeliveryAgentChoice = "claude-code" | "cursor" | "codex" | "inbox";
export interface DeliverySelection {
  agent: DeliveryAgentChoice;
  session: "persistent" | "fresh"; // accumulate context across fixes, or start clean each time
  autonomy: "standard" | "full"; // standard = edits + run tests; full = no sandbox/prompts
}

// How Heckle hands an approved fix to a headless Cursor agent (`cursor-agent`).
export interface CursorDelivery {
  // "persistent" (default): one owned chat (minted via `create-chat`, id kept in
  // .heckle/cursor-session-id) so fixes accumulate. "fresh": new each time. Or a pinned chat id.
  session?: "persistent" | "fresh" | string;
  // --force lets edits actually land in headless mode (plain -p only proposes). Default true.
  force?: boolean;
  model?: string;
}

// How Heckle hands an approved fix to the headless OpenAI Codex CLI (`codex exec`).
export interface CodexDelivery {
  // "fresh" (default): new session per fix. "continue": resume the newest session in the project
  // dir (accumulates, but can collide with your own codex sessions there). Or a pinned session id.
  // Codex has no client-supplied id, hence no auto-minted "persistent" mode.
  session?: "fresh" | "continue" | string;
  sandbox?: string; // "workspace-write" (default) | "read-only" | "danger-full-access"
  askForApproval?: string; // "never" (default) so a non-interactive run is not blocked by a prompt
  skipGitRepoCheck?: boolean; // default true: codex exec otherwise requires a git repo
  model?: string;
}

// How Heckle hands an approved fix to a headless Claude Code process.
export interface ClaudeCodeDelivery {
  // Session strategy so fixes carry context across dispatches:
  //  "persistent" (default) - all fixes append to ONE owned conversation (id kept in
  //                           .heckle/claude-session-id) so fix N sees fixes 1..N-1.
  //  "fresh"                - a new, context-less session per fix (old behavior).
  //  a UUID string          - pin to that exact conversation.
  session?: "persistent" | "fresh" | string;
  // Permission posture for the non-interactive fix. The approval click was the human gate.
  //  "acceptEdits" (default) lets file edits land; other shell/network needs allowedTools.
  //  "bypassPermissions" lets it do anything unprompted (fastest, least safe).
  permissionMode?: string;
  // Tools the fix may run without a prompt, passed through as --allowedTools (e.g. so it can
  // run the project's tests). Empty means edits only.
  allowedTools?: string[];
}

export interface HeckleConfig {
  drafting: { provider: DraftingProvider; model: string; baseUrl: string };
  voice: { provider: VoiceProvider };
  delivery: { order: DeliveryAdapterName[]; claudeCode?: ClaudeCodeDelivery; cursor?: CursorDelivery; codex?: CodexDelivery };
  agent: AgentTarget;
  memory?: { embedProvider: EmbedProvider; embedModel: string };
  privacy: { localOnly: boolean };
}

// ---------- Capture context ----------

export type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug";

export interface ConsoleEntry {
  id: string;
  level: ConsoleLevel;
  args: string[];
  ts: number;
}

export interface NetworkEntry {
  id: string;
  method: string;
  url: string;
  status?: number;
  ok?: boolean;
  durationMs?: number;
  requestBody?: string;
  responseBody?: string;
  ts: number;
}

// What the user was pointing at when they captured: highlighted text and/or the element under
// the last click. Lets the model resolve "this / here / that" and set a concrete target.
export interface PointedTarget {
  text?: string; // highlighted text, if any
  selector?: string; // a CSS selector for the pointed element
  label?: string; // human-readable description, e.g. <button.cta> "Subscribe"
}

export interface ContextBundle {
  url: string;
  flow?: string;
  console: ConsoleEntry[];
  network: NetworkEntry[];
  domSnapshotId?: string;
  rrwebEvents?: unknown[];
  selection?: PointedTarget;
  capturedAt: number;
}

// ---------- Memory (knot-lite) ----------

export type IssueStatus = "open" | "fixed" | "recurring";

export interface Issue {
  id: string;
  status: IssueStatus;
  createdAt: number;
  updatedAt: number;
  flow?: string;
  summary: string;
  contextRef?: string;
}

// The memory annotation that produces the hero moment.
export type HistoryKind = "flagged-before" | "still-open" | "recurring";

export interface HistoryAnnotation {
  kind: HistoryKind;
  note: string;
  issueId: string;
}

// ---------- Feedback (mirror of the zod schema in feedback.ts) ----------

export type Severity = "blocker" | "bug" | "polish";

export interface Feedback {
  id: string;
  intent: string;
  target: { selector?: string; flow?: string };
  severity: Severity;
  repro: string[];
  context: { consoleRefs: string[]; networkRefs: string[]; domSnapshotId?: string };
  fixHint?: string;
  // Added by the orchestrator from memory recall; null when this is new.
  history?: HistoryAnnotation | null;
}

// ---------- Delivery ----------

export interface DeliveryResult {
  adapter: DeliveryAdapterName;
  ok: boolean;
  detail?: string;
}

// ---------- Capture history (the viewable "what did it capture + decide" trail) ----------

// A trimmed, persisted record of one capture: what the user said, what was captured, and the
// outcome. Kept in .heckle/captures.json so you can look back across sessions.
export interface CaptureRecord {
  id: string; // the trigger id
  ts: number;
  url: string;
  flow?: string;
  transcript: string;
  selection?: PointedTarget;
  console: { level: string; text: string }[]; // trimmed console lines that were in context
  network: { method: string; url: string; status?: number; ok?: boolean }[]; // trimmed
  stats: { console: number; network: number; rrweb: number };
  outcome: "capturing" | "drafted" | "noissue" | "delivered" | "fixed" | "failed" | "error";
  reason?: string; // why it declined / errored
  intent?: string; // the drafted instruction, if any
  severity?: string;
  feedbackId?: string;
  progress?: string; // one live line while the agent fix runs ("Editing Hero.tsx"), cleared when it ends
  dispatchedAt?: number; // when the fix was handed to the agent, for the widget's elapsed timer
}

// ---------- Wire protocol (widget <-> daemon over WebSocket) ----------

export type ClientMessage =
  | { type: "hello"; url: string }
  | { type: "trigger"; intentText: string; context: ContextBundle; insist?: boolean }
  | { type: "approve"; feedbackId: string; edited?: Partial<Feedback> }
  // Run an item from the panel (dispatch it to the agent): an inbox item, or a retry of one that
  // did not land. Keyed by captureId (the row), since its pending Feedback is long gone.
  | { type: "run"; captureId: string }
  // Remove a row entirely: drops the capture record, any un-approved draft, and the item from
  // .heckle/inbox.md. Keyed by captureId (the row).
  | { type: "remove"; captureId: string }
  | { type: "setDelivery"; selection: DeliverySelection }
  // Configure the drafting model from the widget gear (persisted to the user config layer, then the
  // provider is rebuilt live). provider = "ollama" | "anthropic" | any OpenAI-compatible name;
  // baseUrl for a custom/OpenAI-compatible endpoint; apiKey for cloud.
  | { type: "setConfig"; provider?: string; model?: string; baseUrl?: string; apiKey?: string; voice?: string }
  | { type: "history" };

export type ServerMessage =
  // project = the daemon's project root, so the widget can scope per-project state (e.g. the
  // saved gear preference) even though every project shares the same localhost origin.
  // drafting = the current model, so the gear's Model section reflects it (never carries the key).
  | { type: "ready"; daemon: string; delivery?: DeliverySelection; project?: string; drafting?: { provider: string; model: string; baseUrl?: string } }
  // Pushed after setConfig so the gear reflects the new model (and any provider error).
  | { type: "config"; drafting: { provider: string; model: string; baseUrl?: string }; error?: string }
  | { type: "history"; captures: CaptureRecord[] }
  // Pushed whenever a single capture's state changes (added, drafted, dispatched, progress line,
  // fixed/failed), so the widget's live task list re-renders that one row without re-fetching.
  | { type: "capture"; record: CaptureRecord }
  // Pushed when a row is removed, so every open widget drops it.
  | { type: "removed"; captureId: string }
  | { type: "ack"; triggerId: string; stats: { console: number; network: number; rrweb: number } }
  | { type: "draft"; feedback: Feedback; attachments?: { console: ConsoleEntry[]; network: NetworkEntry[] } }
  | { type: "noissue"; reason: string }
  | { type: "delivered"; feedbackId: string; results: DeliveryResult[] }
  // Pushed asynchronously when the background agent fix process exits (success or failure).
  | { type: "fixStatus"; feedbackId: string; ok: boolean; detail?: string }
  | { type: "error"; message: string };

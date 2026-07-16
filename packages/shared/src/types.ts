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
  ambient?: {
    ignore?: string[];
    performance?: { cls?: boolean; longTasks?: boolean; hydration?: boolean };
  };
}

// ---------- Capture context ----------

export type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug";

export interface ConsoleEntry {
  id: string;
  level: ConsoleLevel;
  args: string[];
  stack?: string;
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
  responseHeaders?: Record<string, string>;
  ts: number;
}

// Where a pointed element's markup lives, read from a framework's dev hook (React fiber
// _debugSource / __source, Svelte __svelte_meta, Vue data-v-inspector / __file). Enables the fast
// lane: a copy or style tweak can be applied as a direct source edit instead of a full agent round
// trip. Dev-only and best-effort; `line` may be absent (e.g. Vue file-only), and the whole thing is
// absent when nothing resolves (production build, no dev hook), in which case the daemon falls back
// to searching source for the literal, then to the normal agent path.
export interface SourceLocation {
  file: string;
  line?: number;
  column?: number;
}

// What the user was pointing at when they captured: highlighted text and/or the element under
// the last click. Lets the model resolve "this / here / that" and set a concrete target.
export interface ReproTarget {
  testid?: string;
  role?: string;
  name?: string;
  css?: string;
}

export interface PointedTarget {
  text?: string; // highlighted text, if any
  selector?: string; // a CSS selector for the pointed element
  label?: string; // human-readable description, e.g. <button.cta> "Subscribe"
  target?: ReproTarget;
  parentTarget?: ReproTarget;
  source?: SourceLocation; // where this element's JSX lives, when resolvable (fast lane)
  targetText?: string; // the element's own visible text, for locating a copy literal in source
  className?: string;
  inlineStyle?: Record<string, string>;
  siblingIndex?: number;
  siblingTexts?: string[];
}

export type ReproAction =
  | { type: "goto"; url: string; ts: number }
  | { type: "click"; target: ReproTarget; ts: number }
  | { type: "fill"; target: ReproTarget; value: string; ts: number }
  | { type: "press"; target: ReproTarget; value: string; ts: number }
  | { type: "select"; target: ReproTarget; value: string; ts: number }
  | { type: "check"; target: ReproTarget; checked: boolean; ts: number };

export interface ReproStateSeed {
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  cookies: Array<{ name: string; value: string; domain: string; path: string }>;
}

export type ReproAssertion =
  | { type: "text_equals"; target: ReproTarget; expected: string }
  | { type: "attribute_contains"; target: ReproTarget; attribute: string; expected: string }
  | { type: "attribute_present"; target: ReproTarget; attribute: string; expected: boolean }
  | { type: "style_equals"; target: ReproTarget; property: string; expected: string }
  | { type: "child_text_order"; target: ReproTarget; expected: string[] }
  | { type: "console_clean"; levels: ConsoleLevel[] }
  | { type: "no_failed_requests"; exclude: string[] };

export interface ReproNetworkFixture {
  match: string;
  method: string;
  status: number;
  body_ref: string;
  headers?: Record<string, string>;
  recorded_at: string;
}

export interface ReproArtifact {
  version: 1;
  id: string;
  issue_id: string;
  created_at: string;
  origin: string;
  route: string;
  viewport: { width: number; height: number };
  state_seed: ReproStateSeed;
  actions: ReproAction[];
  network_fixtures: ReproNetworkFixture[];
  assertions: ReproAssertion[];
  utterance: string;
  determinism: {
    runs: number;
    pass_rate: number;
    quarantined: boolean;
    outcomes?: boolean[];
    last_run_at?: string;
  };
  surfaces?: {
    routes: string[];
    files: string[];
    elements: string[];
  };
  verification?: {
    status: "captured" | "fixed" | "didnt_land" | "quarantined";
    runs: number;
    outcomes: boolean[];
    last_run_at: string;
    promoted_at?: string;
    delta?: string[];
  };
}

export interface ContextBundle {
  url: string;
  flow?: string;
  console: ConsoleEntry[];
  network: NetworkEntry[];
  domSnapshotId?: string;
  rrwebEvents?: unknown[];
  selection?: PointedTarget;
  viewport?: { width: number; height: number };
  stateSeed?: ReproStateSeed;
  actions?: ReproAction[];
  capturedAt: number;
}

// ---------- Memory (knot-lite) ----------

export type TeamRole = "reporter" | "shipper";
export type IssueStatus = "open" | "fixed" | "recurring";
export type Authority = "verification" | "human" | "deterministic" | "agent" | "heuristic";

export interface Issue {
  id: string;
  status: IssueStatus;
  createdAt: number;
  updatedAt: number;
  flow?: string;
  summary: string;
  severity?: Severity;
  contextRef?: string;
  observedAt?: number;
  validFrom?: number;
  supersededAt?: number;
  authority?: Authority;
  owner?: string;
  source?: string;
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
  assertions?: ReproAssertion[];
  reproId?: string;
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
  reproId?: string;
  progress?: string; // one live line while the agent fix runs ("Editing Hero.tsx"), cleared when it ends
  dispatchedAt?: number; // when the fix was handed to the agent, for the widget's elapsed timer
  owner?: string;
  source?: string;
}

// ---------- Wire protocol (widget <-> daemon over WebSocket) ----------

export interface AmbientSignal {
  fingerprint: string;
  kind: "console" | "exception" | "rejection" | "network" | "performance";
  summary: string;
  route: string;
  count: number;
  userVisible: boolean;
  context?: ContextBundle;
}

export interface AmbientProposal extends AmbientSignal {
  dismissed: boolean;
  proposedAt: number;
}

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
  | { type: "history" }
  | { type: "ambientSignal"; signal: AmbientSignal }
  | { type: "ambientDismiss"; fingerprint: string }
  | { type: "ambientPromote"; fingerprint: string };

export type ServerMessage =
  // project = the daemon's project root, so the widget can scope per-project state (e.g. the
  // saved gear preference) even though every project shares the same localhost origin.
  // drafting = the current model, so the gear's Model section reflects it (never carries the key).
  | { type: "ready"; daemon: string; delivery?: DeliverySelection; project?: string; drafting?: { provider: string; model: string; baseUrl?: string } }
  // Pushed after setConfig so the gear reflects the new model (and any provider error).
  | { type: "config"; drafting: { provider: string; model: string; baseUrl?: string }; error?: string }
  | { type: "history"; captures: CaptureRecord[] }
  | { type: "ambientDigest"; count: number; proposals: AmbientProposal[] }
  // Pushed whenever a single capture's state changes (added, drafted, dispatched, progress line,
  // fixed/failed), so the widget's live task list re-renders that one row without re-fetching.
  | { type: "capture"; record: CaptureRecord }
  // Pushed when a row is removed, so every open widget drops it.
  | { type: "removed"; captureId: string }
  | { type: "ack"; triggerId: string; stats: { console: number; network: number; rrweb: number } }
  | { type: "draft"; feedback: Feedback; attachments?: { console: ConsoleEntry[]; network: NetworkEntry[] } }
  | { type: "noissue"; reason: string }
  | { type: "answer"; text: string }
  | { type: "delivered"; feedbackId: string; results: DeliveryResult[] }
  // Pushed asynchronously when the background agent fix process exits (success or failure).
  | { type: "fixStatus"; feedbackId: string; ok: boolean; detail?: string }
  | { type: "error"; message: string };

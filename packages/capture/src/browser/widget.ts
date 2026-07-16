// The widget. Thin by design: a launcher button + a panel with a first-class text input
// (you dictate into it with your own OS dictation, TypeWhisper + Parakeet, or type),
// a send button, a status line, and a review card that shows the drafted Feedback with
// Approve / Discard. Rendered in a Shadow DOM so host styles never collide.
import type { AmbientProposal, CaptureRecord, ConsoleEntry, DeliverySelection, Feedback, NetworkEntry } from "../../../shared/src/index.ts";
import { createRecorder } from "./record.ts";

// Minimal Web Speech types (often absent from lib.dom). Erased at runtime.
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;
interface SpeechResultEvent {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
}
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: SpeechResultEvent) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

export interface WidgetApi {
  showStatus(text: string): void;
  setConnected(connected: boolean): void;
  // Stash a drafted Feedback's full detail (repro + receipts) so its task row can render Approve.
  showDraft(feedback: Feedback, attachments?: { console: ConsoleEntry[]; network: NetworkEntry[] }): void;
  // Update one task row from a daemon capture push (added / drafted / running / fixed / failed).
  upsertCapture(record: CaptureRecord): void;
  // Drop a row (in response to the daemon's `removed` push, e.g. removed from another tab).
  removeCapture(captureId: string): void;
  // Seed the task list from the daemon's persisted capture history on connect.
  seedTasks(captures: CaptureRecord[]): void;
  // Wipe the composer input.
  clearInput(): void;
  open(): void;
  // Reconcile with the daemon on connect: adopt its routing unless the gear has a saved choice.
  onReady(daemonSelection?: DeliverySelection, project?: string): void;
  // Reflect the current drafting model in the gear (from `ready` or a `config` push).
  setDrafting(drafting?: { provider: string; model: string }, error?: string): void;
  setAmbient(proposals: AmbientProposal[]): void;
}

export interface WidgetOptions {
  onSubmit: (text: string, insist?: boolean) => void;
  onApprove: (feedbackId: string, edited?: Partial<Feedback>) => void; // edited = ship a tweaked instruction
  onRun?: (captureId: string) => void; // run an inbox item (or retry a failed one) from the panel
  onRemove: (captureId: string) => void; // remove a row (drops the draft/inbox item too)
  onSetDelivery?: (selection: DeliverySelection) => void; // gear changed dispatch routing
  onSetConfig?: (cfg: { provider: string; model?: string; baseUrl?: string; apiKey?: string }) => void; // gear changed the model
  onAmbientPromote?: (fingerprint: string) => void;
  onAmbientDismiss?: (fingerprint: string) => void;
  voiceProvider?: string; // "local" | "webspeech" | "deepgram"
  sttAvailable?: boolean; // daemon has the local Parakeet STT worker
  onVoice?: (wav: Blob) => Promise<string>; // send recorded audio to the daemon, get text back
}

const STYLES = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .launcher {
    position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
    width: 42px; height: 42px; border-radius: 50%; border: none; cursor: pointer;
    background: #111; color: #fff; line-height: 1;
    display: inline-flex; align-items: center; justify-content: center;
    box-shadow: 0 6px 24px rgba(0,0,0,.28); transition: transform .12s ease, width .15s ease, height .15s ease;
  }
  .launcher:hover { filter: brightness(1.12); }
  /* The launcher mark: a brand "h" (coral gradient), clean and recognizable. */
  .hmark { font-size: 21px; font-weight: 800; line-height: 1; background: linear-gradient(92deg,#ff6a3d,#ff3d6e); -webkit-background-clip: text; background-clip: text; color: transparent; -webkit-text-fill-color: transparent; }
  /* While recording the launcher shrinks to a small pulsing "heartbeat" dot, out of the way. */
  .launcher.rec { width: 16px; height: 16px; background: #e5484d; animation: heartbeat 1.2s ease-out infinite; }
  .launcher.rec .hmark, .launcher.rec .dot { display: none; }
  @keyframes heartbeat {
    0% { box-shadow: 0 3px 10px rgba(0,0,0,.25), 0 0 0 0 rgba(229,72,77,.5); }
    70% { box-shadow: 0 3px 10px rgba(0,0,0,.25), 0 0 0 11px rgba(229,72,77,0); }
    100% { box-shadow: 0 3px 10px rgba(0,0,0,.25), 0 0 0 0 rgba(229,72,77,0); }
  }
  .dot { position: absolute; top: 5px; right: 5px; width: 9px; height: 9px; border-radius: 50%; background: #e5484d; border: 2px solid #111; }
  .ambientcount { position: absolute; top: -6px; left: -6px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: #ff6a3d; color: #fff; font-size: 10px; font-weight: 700; line-height: 18px; }
  .ambient { margin: 8px 0 12px; display: grid; gap: 6px; }
  .ambientitem { padding: 9px; border: 1px solid rgba(255,255,255,.12); border-radius: 10px; font-size: 11px; color: rgba(255,255,255,.78); }
  .ambientactions { display: flex; gap: 6px; margin-top: 7px; }
  .ambientactions button { border: 0; border-radius: 7px; padding: 4px 8px; cursor: pointer; font-size: 10px; }
  .dot.on { background: #e6e8eb; }
  /* Fix status, visible on the minimized launcher: orange + throbbing halo while the agent works,
     blue when it landed, red when it did not. */
  .dot.working { background: #ff8a3d; animation: dotthrob 1.2s ease-in-out infinite; }
  .dot.fixed { background: #4c8dff; }
  .dot.failed { background: #e5484d; }
  @keyframes dotthrob {
    0% { box-shadow: 0 0 0 0 rgba(255,138,61,.6); }
    70% { box-shadow: 0 0 0 6px rgba(255,138,61,0); }
    100% { box-shadow: 0 0 0 0 rgba(255,138,61,0); }
  }
  /* A tall grey-glass drawer docked to the right edge. Translucent, blurred, contrast text. */
  .panel {
    position: fixed; right: 16px; top: 16px; bottom: 16px; z-index: 2147483647;
    width: 380px; max-width: calc(100vw - 32px);
    background: rgba(28,29,34,0.6);
    backdrop-filter: blur(30px) saturate(150%); -webkit-backdrop-filter: blur(30px) saturate(150%);
    color: #eef0f3; border-radius: 26px; padding: 18px;
    box-shadow: 0 24px 70px rgba(0,0,0,.4); border: 1px solid rgba(255,255,255,0.12);
    display: none; flex-direction: column;
  }
  .panel.open { display: flex; }
  /* Content scrolls; the composer + review bar (text box, actions) stay pinned at the bottom. */
  .content { flex: 1 1 auto; overflow-y: auto; min-height: 0; }
  .composer { flex: 0 0 auto; margin-top: 8px; }
  /* The review bar: the pinned "Ship to agent / Edit / Discard" action for the pending draft, so
     it is always visible without scrolling the row detail. */
  .reviewbar { flex: 0 0 auto; margin-top: 8px; border: 1px solid rgba(255,255,255,0.14); border-radius: 18px; padding: 12px 14px; background: rgba(255,255,255,0.06); }
  .reviewbar[hidden], .draftingbar[hidden], .editbar[hidden] { display: none; }
  .reviewintent { font-size: 13px; color: #eef0f3; line-height: 1.4; margin-bottom: 11px; }
  .reviewact { display: flex; gap: 8px; }
  .reviewact .send { flex: 1; }
  .draftingbar { flex: 0 0 auto; margin-top: 8px; display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: rgba(255,255,255,0.62); padding: 12px 6px; }
  .draftingbar .pip { width: 6px; height: 6px; border-radius: 50%; background: #6ea8fe; animation: pipblink 1.15s ease-in-out infinite; flex: 0 0 auto; }
  .editbar { flex: 0 0 auto; margin-top: 8px; }
  .editlabel { display: block; margin: 8px 2px 4px; font-size: 10px; color: rgba(255,255,255,0.5); text-transform: uppercase; }
  .assertions { margin: 0 0 10px; font-size: 11px; color: rgba(255,255,255,0.68); }
  .assertion { padding: 5px 7px; margin-top: 4px; border-radius: 7px; background: rgba(255,255,255,0.06); }
  .close { position: absolute; top: 14px; right: 14px; width: 30px; height: 30px; border: none; border-radius: 50%; background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.65); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; z-index: 1; }
  .close:hover { background: rgba(255,255,255,0.16); color: #fff; }
  .gear { position: absolute; top: 14px; right: 50px; width: 30px; height: 30px; border: none; border-radius: 50%; background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.65); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; z-index: 1; }
  .gear:hover { background: rgba(255,255,255,0.16); color: #fff; }
  .arcbtn { position: absolute; top: 14px; right: 86px; height: 30px; padding: 0 9px; border: none; border-radius: 999px; background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.65); cursor: pointer; display: inline-flex; align-items: center; gap: 5px; z-index: 1; }
  .arcbtn:hover { background: rgba(255,255,255,0.16); color: #fff; }
  .arcbtn[hidden] { display: none; }
  .arccount { font-size: 11px; font-variant-numeric: tabular-nums; }
  .settings, .archive { display: none; }
  .panel.settings-open .content, .panel.settings-open .status, .panel.settings-open .composer, .panel.settings-open .reviewbar, .panel.settings-open .draftingbar, .panel.settings-open .editbar,
  .panel.archive-open .content, .panel.archive-open .status, .panel.archive-open .composer, .panel.archive-open .reviewbar, .panel.archive-open .draftingbar, .panel.archive-open .editbar { display: none !important; }
  .panel.settings-open .settings { display: block; flex: 1 1 auto; min-height: 0; overflow-y: auto; }
  .panel.archive-open .archive { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; overflow-y: auto; }
  .setrow { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 13px 2px; border-bottom: 1px solid rgba(255,255,255,0.08); font-size: 13px; color: #e7e9ec; }
  /* .setrow sets display, which defeats the plain [hidden] attribute; restore it explicitly. */
  .setrow[hidden] { display: none; }
  .hotkey { border: 1px solid rgba(255,255,255,0.18); background: rgba(255,255,255,0.06); color: #eef0f3; border-radius: 999px; padding: 6px 13px; font-size: 12px; cursor: pointer; }
  .hotkey:hover { border-color: rgba(255,255,255,0.45); }
  .toggle { position: relative; width: 42px; height: 24px; border-radius: 999px; border: none; background: rgba(255,255,255,0.2); cursor: pointer; padding: 0; transition: background .15s; flex: 0 0 auto; }
  .toggle.on { background: linear-gradient(92deg,#ff6a3d,#ff3d6e); }
  .toggle .knob { position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: #fff; transition: transform .15s; }
  .toggle.on .knob { transform: translateX(18px); }
  .sethint { font-size: 11px; color: rgba(255,255,255,0.45); margin-top: 14px; line-height: 1.45; }
  .seg { display: inline-flex; gap: 5px; }
  .seg.wrap { flex-wrap: wrap; }
  .seg button { border: 1px solid rgba(255,255,255,0.18); background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.7); border-radius: 999px; padding: 5px 11px; font-size: 11px; cursor: pointer; }
  .seg button.on { background: linear-gradient(92deg,#ff6a3d,#ff3d6e); border-color: transparent; color: #fff; }
  /* Delivery choices have several options, so stack the label above a wrapping pill row. */
  .setrow.col { flex-direction: column; align-items: stretch; gap: 9px; }
  .setrow.col > span { color: rgba(255,255,255,0.72); }
  .setlabel { font-weight: 650; font-size: 12px; color: rgba(255,255,255,0.5); text-transform: uppercase; letter-spacing: .05em; margin: 4px 2px 2px; }
  .setinput { width: 100%; background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.14); border-radius: 12px; padding: 9px 12px; font-size: 13px; color: #eef0f3; outline: none; }
  .setinput:focus { border-color: rgba(255,255,255,0.4); background: rgba(255,255,255,0.1); }
  .setinput::placeholder { color: rgba(255,255,255,0.35); }
  /* The task list: a quiet, faint trail of what you flagged and where each one is. No icons,
     no colored badges. A finished task is just a faint strikethrough; an active one has a
     small pulsing pip and one live status line. */
  .tasks { display: flex; flex-direction: column; }
  .taskempty { font-size: 12px; color: rgba(255,255,255,0.45); padding: 8px 2px; line-height: 1.5; }
  .task { border-bottom: 1px solid rgba(255,255,255,0.07); }
  .task:last-child { border-bottom: none; }
  /* Collapsed: one tight line (a to-do item). Click the head to expand into the full detail. */
  .taskhead { display: flex; align-items: center; gap: 9px; padding: 10px 4px; cursor: pointer; border-radius: 9px; }
  .taskhead:hover { background: rgba(255,255,255,0.04); }
  .pip { width: 6px; height: 6px; border-radius: 50%; background: rgba(255,255,255,0.3); flex: 0 0 auto; }
  .task.running .pip { background: #6ea8fe; animation: pipblink 1.15s ease-in-out infinite; }
  .task.done .pip { background: rgba(255,255,255,0.2); }
  @keyframes pipblink { 0%,100% { opacity: 1; } 50% { opacity: .25; } }
  .tasktext { flex: 1 1 auto; min-width: 0; font-size: 13px; color: #e7e9ec; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .task.running .tasktext { color: #fff; }
  /* Done = a faint strike, nothing more. */
  .task.done .tasktext { text-decoration: line-through; text-decoration-color: rgba(255,255,255,0.32); color: rgba(255,255,255,0.42); }
  .task.dim .tasktext { color: rgba(255,255,255,0.55); }
  .taskhint { flex: 0 0 auto; font-size: 11px; color: rgba(255,255,255,0.38); font-variant-numeric: tabular-nums; }
  .taskbody { padding: 2px 4px 13px 19px; }
  .taskbody[hidden] { display: none; }
  .saidlabel { font-size: 9px; text-transform: uppercase; letter-spacing: .05em; color: rgba(255,255,255,0.32); margin-bottom: 3px; }
  .saidtext { font-size: 12.5px; color: rgba(255,255,255,0.68); line-height: 1.45; margin-bottom: 11px; }
  .bodystatus { font-size: 12.5px; color: rgba(255,255,255,0.62); margin-bottom: 4px; }
  .taskact { display: flex; gap: 8px; margin-top: 10px; }
  .draftbtn { border: none; border-radius: 999px; background: #f2f3f5; color: #16181c; padding: 8px 14px; font-size: 12.5px; font-weight: 650; cursor: pointer; }
  .draftbtn.ghost { background: transparent; border: 1px solid rgba(255,255,255,0.2); color: rgba(255,255,255,0.7); }
  .draftbtn.ghost:hover { border-color: rgba(255,255,255,0.4); color: #fff; }
  .taskmeta { font-size: 10.5px; color: rgba(255,255,255,0.34); margin-top: 9px; }
  .capdetail { margin-top: 9px; }
  .capline { font-family: ui-monospace, Menlo, monospace; font-size: 10.5px; color: rgba(255,255,255,0.62); padding: 2px 0; word-break: break-word; }
  .capk { color: rgba(255,255,255,0.4); text-transform: uppercase; margin-right: 6px; font-size: 9px; letter-spacing: .03em; }
  .reset { margin-top: 16px; border: 1px solid rgba(255,255,255,0.18); background: transparent; color: rgba(255,255,255,0.7); border-radius: 999px; padding: 8px 14px; font-size: 12px; cursor: pointer; }
  .reset:hover { border-color: rgba(255,255,255,0.4); color: #fff; }
  .title { font-weight: 650; font-size: 14px; margin: 0 0 12px; color: rgba(255,255,255,0.72); }
  .sub { font-size: 12px; color: #777; margin: 0 0 12px; }
  textarea {
    width: 100%; min-height: 58px; resize: vertical; padding: 13px 16px; font-size: 14px;
    background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.12); border-radius: 20px;
    outline: none; color: #eef0f3;
  }
  textarea::placeholder { color: rgba(255,255,255,0.4); }
  textarea:focus { border-color: rgba(255,255,255,0.4); background: rgba(255,255,255,0.1); }
  .row { display: flex; gap: 8px; align-items: center; margin-top: 10px; }
  .mic { width: 44px; height: 44px; border: 1px solid rgba(255,255,255,0.18); border-radius: 50%; background: rgba(255,255,255,0.08); color: #eef0f3; cursor: pointer; flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; }
  .mic:hover { border-color: rgba(255,255,255,0.5); }
  .mic.rec { background: #e5484d; border-color: #e5484d; color: #fff; animation: pulse 1.1s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .55; } }
  .send { flex: 1; border: none; border-radius: 999px; background: linear-gradient(92deg,#ff6a3d,#ff3d6e); color: #fff; padding: 12px 16px; font-size: 14px; font-weight: 650; cursor: pointer; }
  .send:disabled { opacity: .5; cursor: default; }
  /* Shown after a "nothing to flag": lets the user override and draft anyway. */
  .insist { width: 100%; margin-top: 8px; border: 1px solid rgba(255,255,255,0.28); background: rgba(255,255,255,0.06); color: #eef0f3; border-radius: 999px; padding: 9px 14px; font-size: 12px; cursor: pointer; }
  .insist:hover { border-color: rgba(255,255,255,0.55); background: rgba(255,255,255,0.1); }
  .insist[hidden] { display: none; }
  .status { flex: 0 0 auto; font-size: 12px; color: rgba(255,255,255,0.55); margin: 8px 6px 0; min-height: 15px; }
  .hint { font-size: 11px; color: #999; margin-top: 8px; }
  kbd { background:#f1f1f1; border:1px solid #ddd; border-radius:4px; padding:0 4px; font-size:10px; }

  .card { margin-top: 14px; border: 1px solid rgba(255,255,255,0.12); border-radius: 18px; padding: 15px; background: rgba(255,255,255,0.06); color: #e7e9ec; display: none; }
  .card.show { display: block; }
  .cardhead { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .badge { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; padding: 2px 8px; border-radius: 999px; color: rgba(255,255,255,0.6); background: rgba(255,255,255,0.1); }
  .history.show { font-size: 11px; font-weight: 600; color: rgba(255,255,255,0.75); background: rgba(255,255,255,0.1); padding: 2px 8px; border-radius: 999px; }
  .intent { font-size: 14px; font-weight: 600; line-height: 1.35; margin-bottom: 8px; }
  .steps { margin: 0 0 8px 16px; padding: 0; font-size: 12px; color: rgba(255,255,255,0.75); }
  .steps li { margin: 2px 0; }
  .refs { font-size: 11px; color: rgba(255,255,255,0.5); margin-bottom: 8px; }
  .reftoggle { display: inline-block; font-size: 11px; color: rgba(255,255,255,0.55); margin-bottom: 8px; background: none; border: none; padding: 0; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
  .reftoggle:hover, .reftoggle.open { color: rgba(255,255,255,0.85); }
  .attach { margin: 0 0 10px; border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 8px; background: rgba(0,0,0,0.22); max-height: 150px; overflow-y: auto; }
  .attach[hidden] { display: none; }
  .att { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: rgba(255,255,255,0.72); padding: 3px 2px; word-break: break-word; }
  .attk { color: rgba(255,255,255,0.45); text-transform: uppercase; font-size: 9px; margin-right: 6px; letter-spacing: .03em; }
  .atts { color: rgba(255,255,255,0.5); }
  .fixhint { font-size: 12px; color: rgba(255,255,255,0.62); font-style: italic; margin-bottom: 10px; }
  .actions { display: flex; gap: 8px; }
  .approve { flex: 1; border: none; border-radius: 999px; background: #f2f3f5; color: #16181c; padding: 11px; font-size: 13px; font-weight: 650; cursor: pointer; }
  .discard { border: 1px solid rgba(255,255,255,0.2); border-radius: 999px; background: transparent; color: rgba(255,255,255,0.7); padding: 11px 16px; font-size: 13px; cursor: pointer; }
  .discard:hover { border-color: rgba(255,255,255,0.4); color: #fff; }
`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// Short relative time for the history list ("just now", "5m ago", "2h ago", "3d ago").
function relTime(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function urlPath(u: string): string {
  try {
    return new URL(u).pathname || "/";
  } catch {
    return u;
  }
}

export function createWidget(options: WidgetOptions): WidgetApi {
  const host = document.createElement("div");
  host.id = "heckle-root";
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = STYLES;
  shadow.appendChild(style);

  const LAUNCHER_TITLE = "Heckle. Drag to move. Talk: Cmd/Ctrl+Shift+Period. Hide: Cmd/Ctrl+Shift+H";
  const launcher = document.createElement("button");
  launcher.className = "launcher";
  launcher.title = LAUNCHER_TITLE;
  launcher.innerHTML = `<span class="hmark">h</span><span class="dot" id="dot"></span><span class="ambientcount" id="ambientcount" hidden></span>`;

  const voiceProvider = options.voiceProvider ?? "local";
  const SR =
    (window as unknown as { SpeechRecognition?: SpeechRecognitionCtor }).SpeechRecognition ??
    (window as unknown as { webkitSpeechRecognition?: SpeechRecognitionCtor }).webkitSpeechRecognition;
  // Only render the mic where clicking it truly records: in-browser Web Speech, or the
  // local Parakeet worker. Otherwise there is no mic (you type, or dictate into the box).
  const localAvail = !!options.sttAvailable; // daemon Parakeet worker running
  const webAvail = !!SR; // browser Web Speech (Chrome; not Firefox/Zen)
  const canRecord = localAvail || webAvail;
  const micHtml = canRecord
    ? `<button class="mic" id="mic" title="Voice"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg></button>`
    : "";

  const panel = document.createElement("div");
  panel.className = "panel";
  panel.innerHTML = `
    <button class="arcbtn" id="arcbtn" title="Archive" aria-label="Archive" hidden><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4" rx="1"></rect><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"></path><path d="M10 12h4"></path></svg><span class="arccount" id="arccount"></span></button>
    <button class="gear" id="gear" title="Settings" aria-label="Settings"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg></button>
    <button class="close" id="close" title="Close (Esc)" aria-label="Close"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"></line><line x1="18" y1="6" x2="6" y2="18"></line></svg></button>
    <div class="content" id="content">
      <p class="title">Go heckle</p>
      <div class="ambient" id="ambient"></div>
      <div class="tasks" id="tasks"><p class="taskempty">Flag something and it shows up here.</p></div>
    </div>
    <div class="archive" id="archive">
      <p class="title">Archive</p>
      <div class="tasks" id="arctasks"></div>
    </div>
    <div class="status" id="status"></div>
    <div class="reviewbar" id="reviewbar" hidden></div>
    <div class="draftingbar" id="draftingbar" hidden><span class="pip"></span>Drafting…</div>
    <div class="editbar" id="editbar" hidden>
      <textarea id="editta" placeholder="Edit the instruction to the agent"></textarea>
      <label class="editlabel" for="editassertions">Assertions (JSON)</label>
      <textarea id="editassertions" placeholder="[]" spellcheck="false"></textarea>
      <div class="row">
        <button type="button" class="draftbtn ghost" id="canceledit">Cancel</button>
        <button class="send" id="shipedit">Ship to agent</button>
      </div>
    </div>
    <div class="composer" id="composer">
      <textarea id="ta" placeholder="e.g. the total doesn't update when I change quantity"></textarea>
      <div class="row">
        ${micHtml}
        <button class="send" id="send" hidden>Capture it</button>
      </div>
    </div>
    <div class="settings" id="settings">
      <p class="title">Settings</p>
      <p class="setlabel">Delivery</p>
      <div class="setrow col"><span>Fix with</span><div class="seg wrap" id="agentseg"></div></div>
      <div class="setrow col" id="sessionrow"><span>Session memory</span><div class="seg" id="sessionseg"></div></div>
      <div class="setrow col" id="autonomyrow"><span>Autonomy</span><div class="seg" id="autonomyseg"></div></div>
      <p class="sethint" id="deliveryhint"></p>
      <p class="setlabel">Model</p>
      <div class="setrow col"><span>Draft with</span><div class="seg wrap" id="modelseg"></div></div>
      <div class="setrow col"><span>Model name</span><input class="setinput" id="modelname" placeholder="qwen3:14b" spellcheck="false" autocomplete="off" /></div>
      <div class="setrow col" id="modelbaseurlrow" hidden><span>Base URL</span><input class="setinput" id="modelbaseurl" placeholder="https://api.openai.com/v1" spellcheck="false" autocomplete="off" /></div>
      <div class="setrow col" id="modelkeyrow" hidden><span>API key</span><input class="setinput" id="modelkey" type="password" placeholder="sk-..." autocomplete="off" /></div>
      <button type="button" class="reset" id="modelsave">Save model</button>
      <p class="sethint" id="modelhint"></p>
      <p class="setlabel">Voice &amp; keys</p>
      <div class="setrow"><span>Voice input</span><button type="button" class="toggle" id="set-voice" role="switch"><span class="knob"></span></button></div>
      <div class="setrow" id="backendrow" hidden><span>Voice backend</span><div class="seg" id="backendseg"></div></div>
      <div class="setrow"><span>Talk / record</span><button type="button" class="hotkey" id="set-talk"></button></div>
      <div class="setrow"><span>Show / hide</span><button type="button" class="hotkey" id="set-hide"></button></div>
      <button type="button" class="reset" id="reset-hotkeys">Reset hotkeys to defaults</button>
      <p class="sethint">Voice runs on your local model. Change the drafting model in heckle.config.ts.</p>
    </div>
  `;

  shadow.appendChild(launcher);
  shadow.appendChild(panel);
  document.body.appendChild(host);

  const ta = panel.querySelector("#ta") as HTMLTextAreaElement;
  const sendBtn = panel.querySelector("#send") as HTMLButtonElement;
  const statusEl = panel.querySelector("#status") as HTMLDivElement;
  const tasksEl = panel.querySelector("#tasks") as HTMLDivElement;
  const ambientEl = panel.querySelector("#ambient") as HTMLDivElement;
  const ambientCount = launcher.querySelector("#ambientcount") as HTMLSpanElement;
  const micBtn = panel.querySelector("#mic") as HTMLButtonElement | null;
  const closeBtn = panel.querySelector("#close") as HTMLButtonElement;
  const composerEl = panel.querySelector("#composer") as HTMLDivElement;
  const reviewBar = panel.querySelector("#reviewbar") as HTMLDivElement;
  const draftingBar = panel.querySelector("#draftingbar") as HTMLDivElement;
  const editBar = panel.querySelector("#editbar") as HTMLDivElement;
  const editTa = panel.querySelector("#editta") as HTMLTextAreaElement;
  const editAssertions = panel.querySelector("#editassertions") as HTMLTextAreaElement;
  const shipEditBtn = panel.querySelector("#shipedit") as HTMLButtonElement;
  const cancelEditBtn = panel.querySelector("#canceledit") as HTMLButtonElement;
  const gearBtn = panel.querySelector("#gear") as HTMLButtonElement;
  const arcBtn = panel.querySelector("#arcbtn") as HTMLButtonElement;
  const arcCount = panel.querySelector("#arccount") as HTMLSpanElement;
  const archiveEl = panel.querySelector("#archive") as HTMLDivElement;
  const arcTasksEl = panel.querySelector("#arctasks") as HTMLDivElement;
  const setVoiceBtn = panel.querySelector("#set-voice") as HTMLButtonElement;
  const setTalkBtn = panel.querySelector("#set-talk") as HTMLButtonElement;
  const setHideBtn = panel.querySelector("#set-hide") as HTMLButtonElement;
  const backendRow = panel.querySelector("#backendrow") as HTMLDivElement;
  const backendSeg = panel.querySelector("#backendseg") as HTMLDivElement;
  const resetBtn = panel.querySelector("#reset-hotkeys") as HTMLButtonElement;
  const agentSeg = panel.querySelector("#agentseg") as HTMLDivElement;
  const sessionSeg = panel.querySelector("#sessionseg") as HTMLDivElement;
  const autonomySeg = panel.querySelector("#autonomyseg") as HTMLDivElement;
  const sessionRow = panel.querySelector("#sessionrow") as HTMLDivElement;
  const autonomyRow = panel.querySelector("#autonomyrow") as HTMLDivElement;
  const deliveryHint = panel.querySelector("#deliveryhint") as HTMLParagraphElement;
  const modelSeg = panel.querySelector("#modelseg") as HTMLDivElement;
  const modelName = panel.querySelector("#modelname") as HTMLInputElement;
  const modelBaseUrlRow = panel.querySelector("#modelbaseurlrow") as HTMLDivElement;
  const modelBaseUrl = panel.querySelector("#modelbaseurl") as HTMLInputElement;
  const modelKeyRow = panel.querySelector("#modelkeyrow") as HTMLDivElement;
  const modelKey = panel.querySelector("#modelkey") as HTMLInputElement;
  const modelSave = panel.querySelector("#modelsave") as HTMLButtonElement;
  const modelHint = panel.querySelector("#modelhint") as HTMLParagraphElement;
  const dot = launcher.querySelector("#dot") as HTMLSpanElement;

  const setOpen = (open: boolean) => {
    panel.classList.toggle("open", open);
    if (!open) panel.classList.remove("settings-open", "archive-open");
    // The panel is a right-side drawer; hide the launcher while it is open.
    launcher.style.display = open ? "none" : "";
    if (open) setTimeout(() => ta.focus(), 0);
  };
  const isOpen = () => panel.classList.contains("open");
  closeBtn.addEventListener("click", () => setOpen(false));

  // Settings state: voice on/off + rebindable hotkeys, persisted in localStorage.
  type Hotkey = { mod: boolean; shift: boolean; alt: boolean; code: string };
  const DEFAULT_HOTKEYS: { talk: Hotkey; hide: Hotkey } = {
    talk: { mod: true, shift: true, alt: false, code: "Period" },
    hide: { mod: true, shift: true, alt: false, code: "KeyH" },
  };
  let voiceEnabled = (localStorage.getItem("heckle:voice") ?? "on") !== "off";
  let hotkeys = { ...DEFAULT_HOTKEYS };
  try {
    const saved = localStorage.getItem("heckle:hotkeys");
    if (saved) hotkeys = { ...DEFAULT_HOTKEYS, ...JSON.parse(saved) };
  } catch {
    // ignore bad storage
  }
  let capturingHotkey: "talk" | "hide" | null = null;
  const matchHotkey = (e: KeyboardEvent, hk: Hotkey) =>
    (hk.mod ? e.metaKey || e.ctrlKey : !e.metaKey && !e.ctrlKey) &&
    e.shiftKey === hk.shift &&
    e.altKey === hk.alt &&
    e.code === hk.code;
  const codeLabel = (code: string) =>
    code.replace(/^Key/, "").replace(/^Digit/, "").replace("Period", ".").replace("Comma", ",").replace("Slash", "/") || code;
  const fmtHotkey = (hk: Hotkey) =>
    [hk.mod ? "Cmd/Ctrl" : "", hk.shift ? "Shift" : "", hk.alt ? "Alt" : "", codeLabel(hk.code)].filter(Boolean).join("+");

  // Draggable + remembered position, so Heckle never sits on top of the app's own UI.
  // Drag the launcher to move the whole widget; where you drop it is remembered.
  let offset = { x: 0, y: 0 };
  try {
    const saved = localStorage.getItem("heckle:offset");
    if (saved) offset = JSON.parse(saved);
  } catch {
    // storage blocked or corrupt, start at the default corner
  }
  const applyOffset = () => {
    // Only the launcher moves; the panel is a docked right-side drawer.
    launcher.style.transform = `translate(${offset.x}px, ${offset.y}px)`;
  };
  applyOffset();

  let drag: { sx: number; sy: number; bx: number; by: number; moved: boolean } | null = null;
  let suppressClick = false;
  launcher.addEventListener("pointerdown", (e) => {
    drag = { sx: e.clientX, sy: e.clientY, bx: offset.x, by: offset.y, moved: false };
    launcher.style.transition = "none";
    launcher.setPointerCapture(e.pointerId);
  });
  launcher.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) drag.moved = true;
    offset = { x: drag.bx + dx, y: drag.by + dy };
    applyOffset();
  });
  launcher.addEventListener("pointerup", (e) => {
    if (!drag) return;
    suppressClick = drag.moved;
    if (drag.moved) {
      try {
        localStorage.setItem("heckle:offset", JSON.stringify(offset));
      } catch {
        // ignore storage failure
      }
    }
    drag = null;
    launcher.style.transition = "";
    try {
      launcher.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  });

  // Local voice recording, shared by the mic and the launcher so it can minimize while
  // recording: the panel steps aside, the launcher becomes the live stop button, and it
  // comes back with the transcript when you stop. Capture keeps running the whole time.
  const localRecorder = localAvail ? createRecorder() : null;
  let recording = false;
  const startLocalRec = async () => {
    if (!localRecorder) return;
    host.style.display = ""; // reveal the widget if it was hidden, so the record dot shows
    try {
      await localRecorder.start();
      recording = true;
      launcher.classList.add("rec");
      micBtn?.classList.add("rec");
      launcher.title = "Recording, click to stop";
      setOpen(false);
    } catch {
      setOpen(true);
      statusEl.textContent = "Microphone permission denied.";
    }
  };
  const stopLocalRec = async () => {
    if (!localRecorder) return;
    recording = false;
    launcher.classList.remove("rec");
    micBtn?.classList.remove("rec");
    launcher.title = LAUNCHER_TITLE;
    setOpen(true);
    statusEl.textContent = "Transcribing...";
    try {
      const wav = await localRecorder.stop();
      const text = options.onVoice ? (await options.onVoice(wav)).trim() : "";
      if (text) {
        ta.value = ta.value.trim() ? `${ta.value.trim()} ${text}` : text;
        statusEl.textContent = "";
        updateSend();
      } else {
        statusEl.textContent = "Heard nothing. Try again.";
      }
      ta.focus();
    } catch (err) {
      statusEl.textContent = `Transcription failed: ${(err as Error).message}`;
    }
  };

  // Web Speech backend (Chrome only): live transcription into the box, no minimize.
  let recognizing = false;
  let recognition: SpeechRecognitionLike | null = null;
  const stopWebSpeech = () => {
    try {
      recognition?.stop();
    } catch {
      // already stopped
    }
    recognizing = false;
    micBtn?.classList.remove("rec");
  };
  const startWebSpeech = () => {
    if (!SR) return;
    setOpen(true);
    recognition = new SR();
    recognition.lang = "en-US";
    recognition.interimResults = true;
    recognition.continuous = true;
    const base = ta.value.trim();
    recognition.onresult = (e: SpeechResultEvent) => {
      let txt = "";
      for (let i = e.resultIndex; i < e.results.length; i++) txt += e.results[i][0].transcript;
      ta.value = (base ? `${base} ` : "") + txt.trim();
      updateSend();
    };
    recognition.onerror = () => stopWebSpeech();
    recognition.onend = () => {
      recognizing = false;
      micBtn?.classList.remove("rec");
    };
    try {
      recognition.start();
      recognizing = true;
      micBtn?.classList.add("rec");
      statusEl.textContent = "Listening...";
    } catch {
      micBtn?.classList.remove("rec");
    }
  };

  // The transcription backend the mic/hotkey uses; persisted, validated against availability.
  const backends: Array<{ id: string; label: string }> = [];
  if (localAvail) backends.push({ id: "local", label: "Local (Parakeet)" });
  if (webAvail) backends.push({ id: "webspeech", label: "Browser (Web Speech)" });
  let voiceBackend = localStorage.getItem("heckle:backend") ?? (voiceProvider === "webspeech" ? "webspeech" : "local");
  if (!backends.some((b) => b.id === voiceBackend)) voiceBackend = backends[0]?.id ?? "local";

  const toggleVoice = () => {
    if (voiceBackend === "webspeech" && SR) {
      recognizing ? stopWebSpeech() : startWebSpeech();
    } else if (localRecorder) {
      recording ? void stopLocalRec() : void startLocalRec();
    }
  };

  launcher.addEventListener("click", () => {
    if (suppressClick) {
      suppressClick = false;
      return; // that pointer sequence was a drag, not a click
    }
    if (recording) {
      void stopLocalRec();
      return;
    }
    setOpen(!isOpen());
  });

  // Hotkey: Cmd/Ctrl+Shift+H hides or shows Heckle entirely; Escape closes the panel.
  // Hiding does not stop capture, so you can clear the screen, reproduce, then bring it back.
  window.addEventListener("keydown", (e) => {
    if (capturingHotkey) return; // a rebind is in progress (handled by the capture listener)
    if (voiceEnabled && canRecord && matchHotkey(e, hotkeys.talk)) {
      e.preventDefault(); // talk: start/stop the selected voice backend from anywhere
      toggleVoice();
    } else if (matchHotkey(e, hotkeys.hide)) {
      e.preventDefault();
      host.style.display = host.style.display === "none" ? "" : "none";
    } else if (e.key === "Escape" && isOpen() && !recording) {
      setOpen(false);
    }
  });

  // "Capture it" only appears once there is something to capture (typed or dictated).
  const updateSend = () => {
    sendBtn.hidden = !ta.value.trim();
  };
  const submit = (insist = false) => {
    const text = ta.value.trim();
    if (!text) {
      statusEl.textContent = "Say or type what is wrong first.";
      ta.focus();
      return;
    }
    options.onSubmit(text, insist);
    // The words now live in the task row (its transcript), so the composer clears for the next
    // note. If the model declines, that task's row offers "draft it anyway" with the same words.
    ta.value = "";
    updateSend();
  };
  sendBtn.addEventListener("click", () => submit(false));
  ta.addEventListener("input", updateSend);
  ta.addEventListener("keydown", (e) => {
    // Enter sends; Shift+Enter inserts a newline.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit(false);
    }
  });

  // Edit the drafted instruction before shipping (like editing a message before sending).
  shipEditBtn.addEventListener("click", () => {
    if (!editing) return;
    const feedbackId = editing.feedbackId;
    const intent = editTa.value.trim();
    let assertions: Feedback["assertions"];
    try {
      assertions = JSON.parse(editAssertions.value || "[]") as Feedback["assertions"];
      if (!Array.isArray(assertions)) throw new Error("assertions must be an array");
    } catch (err) {
      statusEl.textContent = `Invalid assertions: ${(err as Error).message}`;
      return;
    }
    editing = null;
    options.onApprove(feedbackId, { ...(intent ? { intent } : {}), assertions });
    renderComposer();
  });
  cancelEditBtn.addEventListener("click", () => {
    editing = null;
    renderComposer();
  });

  // The mic and the talk hotkey both toggle the currently selected voice backend.
  if (micBtn) micBtn.addEventListener("click", () => toggleVoice());

  // Settings panel wiring.
  const applyVoiceEnabled = () => {
    if (micBtn) micBtn.style.display = voiceEnabled && canRecord ? "" : "none";
  };
  const renderSettings = () => {
    setVoiceBtn.classList.toggle("on", voiceEnabled);
    setTalkBtn.textContent = fmtHotkey(hotkeys.talk);
    setHideBtn.textContent = fmtHotkey(hotkeys.hide);
    backendSeg.querySelectorAll("button").forEach((btn) => {
      (btn as HTMLElement).classList.toggle("on", (btn as HTMLButtonElement).dataset.b === voiceBackend);
    });
    renderDelivery();
  };
  // Voice backend selector, only shown when there is a real choice (e.g. Chrome has both).
  if (backends.length >= 2) {
    backendRow.hidden = false;
    backendSeg.innerHTML = backends.map((b) => `<button type="button" data-b="${b.id}">${b.label}</button>`).join("");
    backendSeg.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        voiceBackend = (btn as HTMLButtonElement).dataset.b ?? voiceBackend;
        try {
          localStorage.setItem("heckle:backend", voiceBackend);
        } catch {
          // ignore storage failure
        }
        renderSettings();
      });
    });
  }
  // Delivery routing (the gear controls where an approved fix goes). Persisted in localStorage
  // and reconciled with the daemon on connect (onReady). The daemon maps this high-level choice
  // onto the detailed per-agent config, so the widget stays thin.
  const AGENTS: Array<{ id: DeliverySelection["agent"]; label: string }> = [
    { id: "claude-code", label: "Claude" },
    { id: "cursor", label: "Cursor" },
    { id: "codex", label: "Codex" },
    { id: "inbox", label: "Inbox only" },
  ];
  const SESSIONS: Array<{ id: DeliverySelection["session"]; label: string }> = [
    { id: "persistent", label: "Persistent" },
    { id: "fresh", label: "Fresh" },
  ];
  const AUTONOMY: Array<{ id: DeliverySelection["autonomy"]; label: string }> = [
    { id: "standard", label: "Standard" },
    { id: "full", label: "Full" },
  ];
  const DEFAULT_DELIVERY: DeliverySelection = { agent: "claude-code", session: "persistent", autonomy: "standard" };
  let delivery: DeliverySelection = { ...DEFAULT_DELIVERY };
  let hasDeliveryPref = false;
  // The saved gear choice is scoped per PROJECT, not per origin: every project shares the same
  // localhost origin, so a global key would carry one project's routing (e.g. full-autonomy
  // Claude) into another that deliberately configured inbox-only. The daemon tells us which
  // project it serves in the ready message; until then nothing is loaded or persisted.
  let deliveryKey: string | null = null;
  const saveDeliveryPref = () => {
    if (!deliveryKey) return;
    try {
      localStorage.setItem(deliveryKey, JSON.stringify(delivery));
    } catch {
      // ignore storage failure
    }
  };
  const fillSeg = (seg: HTMLDivElement, items: Array<{ id: string; label: string }>) => {
    seg.innerHTML = items.map((i) => `<button type="button" data-v="${i.id}">${i.label}</button>`).join("");
  };
  fillSeg(agentSeg, AGENTS);
  fillSeg(sessionSeg, SESSIONS);
  fillSeg(autonomySeg, AUTONOMY);
  const agentLabel = (id: string) => AGENTS.find((a) => a.id === id)?.label ?? id;
  function renderDelivery(): void {
    const mark = (seg: HTMLDivElement, val: string) =>
      seg
        .querySelectorAll("button")
        .forEach((b) => (b as HTMLElement).classList.toggle("on", (b as HTMLButtonElement).dataset.v === val));
    mark(agentSeg, delivery.agent);
    mark(sessionSeg, delivery.session);
    mark(autonomySeg, delivery.autonomy);
    const inbox = delivery.agent === "inbox";
    sessionRow.hidden = inbox;
    autonomyRow.hidden = inbox;
    deliveryHint.textContent = inbox
      ? "Approved fixes wait in .heckle/inbox.md. Run “check Heckle” in your own agent session when ready."
      : `Approved fixes run in ${agentLabel(delivery.agent)} automatically. Persistent keeps one session so fixes build on each other; Full drops the sandbox and prompts.`;
  }
  const changeDelivery = (patch: Partial<DeliverySelection>) => {
    delivery = { ...delivery, ...patch };
    hasDeliveryPref = true;
    saveDeliveryPref();
    renderDelivery();
    options.onSetDelivery?.(delivery);
  };
  agentSeg
    .querySelectorAll("button")
    .forEach((b) => b.addEventListener("click", () => changeDelivery({ agent: (b as HTMLButtonElement).dataset.v as DeliverySelection["agent"] })));
  sessionSeg
    .querySelectorAll("button")
    .forEach((b) => b.addEventListener("click", () => changeDelivery({ session: (b as HTMLButtonElement).dataset.v as DeliverySelection["session"] })));
  autonomySeg
    .querySelectorAll("button")
    .forEach((b) => b.addEventListener("click", () => changeDelivery({ autonomy: (b as HTMLButtonElement).dataset.v as DeliverySelection["autonomy"] })));
  renderDelivery();

  // Model section: pick the drafting provider + model (+ base URL / key) without editing config.
  // "OpenAI-compat" is the catch-all: point the base URL at any OpenAI-compatible endpoint
  // (OpenAI, OpenRouter, Groq, Together, Mistral, a local server, ...), so any model works.
  const MODELS: Array<{ id: string; label: string; cloud: boolean; url: boolean; baseUrl?: string }> = [
    { id: "ollama", label: "Ollama (local)", cloud: false, url: false },
    { id: "deepseek", label: "DeepSeek", cloud: true, url: true, baseUrl: "https://api.deepseek.com" },
    { id: "openai", label: "OpenAI-compat", cloud: true, url: true },
    { id: "anthropic", label: "Claude", cloud: true, url: false },
  ];
  let draftProvider = "ollama";
  fillSeg(modelSeg, MODELS.map((m) => ({ id: m.id, label: m.label })));
  const renderModel = () => {
    const m = MODELS.find((x) => x.id === draftProvider);
    modelSeg.querySelectorAll("button").forEach((b) => (b as HTMLElement).classList.toggle("on", (b as HTMLButtonElement).dataset.v === draftProvider));
    modelKeyRow.hidden = !(m?.cloud ?? false);
    modelBaseUrlRow.hidden = !(m?.url ?? false);
  };
  modelSeg.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => {
      draftProvider = (b as HTMLButtonElement).dataset.v ?? draftProvider;
      const m = MODELS.find((x) => x.id === draftProvider);
      // Prefill a known base URL when switching to a preset that has one; leave custom entries alone.
      if (m?.baseUrl && !modelBaseUrl.value.trim()) modelBaseUrl.value = m.baseUrl;
      renderModel();
    }),
  );
  modelSave.addEventListener("click", () => {
    const m = MODELS.find((x) => x.id === draftProvider);
    options.onSetConfig?.({
      provider: draftProvider,
      model: modelName.value.trim() || undefined,
      baseUrl: m?.url ? modelBaseUrl.value.trim() || undefined : undefined,
      apiKey: modelKey.value.trim() || undefined,
    });
    modelHint.textContent = "Saving…";
    modelKey.value = ""; // never keep the key sitting in the field
  });
  renderModel();

  applyVoiceEnabled();
  renderSettings();
  gearBtn.addEventListener("click", () => {
    panel.classList.remove("archive-open");
    panel.classList.toggle("settings-open");
    renderSettings();
  });
  arcBtn.addEventListener("click", () => {
    panel.classList.remove("settings-open");
    const opening = !panel.classList.contains("archive-open");
    panel.classList.toggle("archive-open", opening);
    if (opening) renderArchive();
  });
  setVoiceBtn.addEventListener("click", () => {
    voiceEnabled = !voiceEnabled;
    try {
      localStorage.setItem("heckle:voice", voiceEnabled ? "on" : "off");
    } catch {
      // ignore storage failure
    }
    applyVoiceEnabled();
    renderSettings();
  });
  const beginCapture = (which: "talk" | "hide", btn: HTMLButtonElement) => {
    capturingHotkey = which;
    btn.textContent = "press keys...";
  };
  setTalkBtn.addEventListener("click", () => beginCapture("talk", setTalkBtn));
  setHideBtn.addEventListener("click", () => beginCapture("hide", setHideBtn));
  resetBtn.addEventListener("click", () => {
    hotkeys = { talk: { ...DEFAULT_HOTKEYS.talk }, hide: { ...DEFAULT_HOTKEYS.hide } };
    try {
      localStorage.removeItem("heckle:hotkeys");
    } catch {
      // ignore storage failure
    }
    capturingHotkey = null;
    renderSettings();
  });
  const MODIFIER_CODES = ["ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "MetaLeft", "MetaRight", "AltLeft", "AltRight"];
  window.addEventListener(
    "keydown",
    (e) => {
      if (!capturingHotkey) return;
      if (MODIFIER_CODES.includes(e.code)) return; // wait for a real (non-modifier) key
      e.preventDefault();
      e.stopPropagation();
      if (e.code !== "Escape") {
        hotkeys[capturingHotkey] = { mod: e.metaKey || e.ctrlKey, shift: e.shiftKey, alt: e.altKey, code: e.code };
        try {
          localStorage.setItem("heckle:hotkeys", JSON.stringify(hotkeys));
        } catch {
          // ignore storage failure
        }
      }
      capturingHotkey = null;
      renderSettings();
    },
    true,
  );

  // ---- The live task list -------------------------------------------------------------------
  // `tasks` is the source of truth for what's shown (seeded from the daemon's capture history on
  // connect, updated row-by-row by capture pushes). `draftDetail` holds the full drafted Feedback
  // (repro + attachments) for rows awaiting approval; `expanded` remembers which rows are open so
  // re-renders never collapse them.
  let tasks: CaptureRecord[] = [];
  const draftDetail = new Map<string, { feedback: Feedback; attachments?: { console: ConsoleEntry[]; network: NetworkEntry[] } }>();
  const expanded = new Set<string>();
  let ticker: ReturnType<typeof setInterval> | null = null;
  // Set while the user is editing a drafted instruction before shipping it.
  let editing: { feedbackId: string } | null = null;

  const fmtElapsed = (ms: number) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const isRunning = (c: CaptureRecord) => c.outcome === "delivered" && !!c.dispatchedAt;

  // Tick the elapsed time in place (no re-render, so expand state + the live line survive).
  const tick = () => {
    panel.querySelectorAll(".elapsed[data-since]").forEach((el) => {
      const since = Number((el as HTMLElement).dataset.since);
      if (since) el.textContent = fmtElapsed(Date.now() - since);
    });
    if (!tasks.some(isRunning) && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  };
  const ensureTicker = () => {
    tick();
    if (!ticker && tasks.some(isRunning)) ticker = setInterval(tick, 1000);
  };

  // The captured-context detail a row expands to show (console/network lines, pointed element).
  const detailLines = (c: CaptureRecord): string => {
    const lines: string[] = [];
    if (c.selection) {
      const s = c.selection;
      lines.push(`<div class="capline"><span class="capk">pointed</span>${escapeHtml(s.label ?? s.selector ?? "")}${s.text ? ` · “${escapeHtml(s.text)}”` : ""}</div>`);
    }
    for (const e of c.console) lines.push(`<div class="capline"><span class="capk">${escapeHtml(e.level)}</span>${escapeHtml(e.text)}</div>`);
    for (const n of c.network) {
      const st = n.status ?? (n.ok === false ? "failed" : "");
      lines.push(`<div class="capline"><span class="capk">${escapeHtml(n.method)}</span>${escapeHtml(n.url)} ${escapeHtml(String(st))}</div>`);
    }
    return lines.join("");
  };

  // The inline review block for a task awaiting approval: the drafted intent + repro + receipts
  // (rich if the draft message has arrived; falls back to the record's intent) and the actions.
  const draftBlock = (c: CaptureRecord): string => {
    const d = c.feedbackId ? draftDetail.get(c.feedbackId) : undefined;
    const steps = d ? d.feedback.repro.map((s) => `<li>${escapeHtml(s)}</li>`).join("") : "";
    const con = d?.attachments?.console ?? [];
    const net = d?.attachments?.network ?? [];
    const att =
      con.length || net.length
        ? `<div class="attach">${
            con.map((e) => `<div class="att"><span class="attk">${escapeHtml(e.level)}</span>${escapeHtml(e.args.join(" ").slice(0, 300))}</div>`).join("") +
            net.map((e) => `<div class="att"><span class="attk">${escapeHtml(e.method)}</span>${escapeHtml(e.url)} <span class="atts">${escapeHtml(String(e.status ?? (e.ok === false ? "failed" : "?")))}</span></div>`).join("")
          }</div>`
        : "";
    const hint = d?.feedback.fixHint ? `<div class="fixhint">${escapeHtml(d.feedback.fixHint)}</div>` : "";
    const hist = d?.feedback.history ? `<div class="taskmeta">${escapeHtml(d.feedback.history.note)}</div>` : "";
    const assertions = (d?.feedback.assertions ?? [])
      .map((assertion) => `<div class="assertion">${escapeHtml(JSON.stringify(assertion))}</div>`)
      .join("");
    // Intent + the Ship/Edit/Discard actions live in the pinned bottom bar (always visible); the
    // expanded row just carries the supporting detail (repro + receipts).
    return `${hist}${steps ? `<ul class="steps">${steps}</ul>` : ""}${assertions ? `<div class="assertions">Assertions${assertions}</div>` : ""}${att}${hint}`;
  };

  // A trailing "Remove" button for a settled row (drops the record + its inbox item).
  const removeBtn = (c: CaptureRecord) => `<button class="draftbtn ghost" data-remove="${escapeHtml(c.id)}">Remove</button>`;

  // ---- the collapsed one-line-per-task view --------------------------------------------------
  const VISIBLE = 6; // keep the list short: the newest few; the rest go to the archive.
  let archivedTasks: CaptureRecord[] = [];

  const rowClass = (c: CaptureRecord): string => {
    if (c.outcome === "fixed") return "done";
    if (isRunning(c)) return "running";
    if (c.outcome === "failed" || c.outcome === "noissue" || c.outcome === "error") return "dim";
    return "";
  };
  // The single collapsed line. While running it shows the live activity (like Claude's thinking
  // lines updating in place); otherwise the concise drafted intent, falling back to your words.
  const rowText = (c: CaptureRecord): string => {
    if (isRunning(c)) return c.progress || "Working on it";
    return c.intent || c.transcript || "(voice / context only)";
  };
  // A short faint hint on the right of the collapsed line.
  const rowHint = (c: CaptureRecord): string => {
    switch (c.outcome) {
      case "capturing":
        return "capturing…";
      case "drafted":
        return "review";
      case "delivered":
        return c.dispatchedAt ? `<span class="elapsed" data-since="${c.dispatchedAt}"></span>` : "in inbox";
      case "failed":
        return "didn’t land";
      case "noissue":
        return "nothing to flag";
      case "error":
        return "error";
      default:
        return "";
    }
  };
  // The full detail revealed when a row is expanded.
  const rowBody = (c: CaptureRecord): string => {
    const parts: string[] = [];
    if (c.transcript && c.transcript !== rowText(c)) {
      parts.push(`<div class="saidlabel">you said</div><div class="saidtext">${escapeHtml(c.transcript)}</div>`);
    }
    if (c.outcome === "drafted") parts.push(draftBlock(c));
    else if (isRunning(c)) parts.push(`<div class="bodystatus">${escapeHtml(c.progress || "Working on it")}</div>`);
    else if (c.outcome === "delivered")
      // In the inbox with no agent run yet: run it here (self-contained), or remove it.
      parts.push(
        `<div class="bodystatus">Saved to .heckle/inbox.md.</div><div class="taskact"><button class="draftbtn" data-run="${escapeHtml(c.id)}">Run it with the agent</button>${removeBtn(c)}</div>`,
      );
    else if (c.outcome === "fixed")
      parts.push(`<div class="bodystatus">Fixed. Reload the page to see it.</div><div class="taskact">${removeBtn(c)}</div>`);
    else if (c.outcome === "failed")
      parts.push(
        `<div class="bodystatus">Didn’t land. Check the .heckle dispatch log.</div><div class="taskact"><button class="draftbtn" data-run="${escapeHtml(c.id)}">Run again</button>${removeBtn(c)}</div>`,
      );
    else if (c.outcome === "noissue")
      parts.push(
        `<div class="bodystatus">Nothing to flag${c.reason ? `: ${escapeHtml(c.reason)}` : ""}.</div><div class="taskact"><button class="draftbtn ghost" data-insist="${escapeHtml(c.id)}">It's a real issue, draft it anyway</button>${removeBtn(c)}</div>`,
      );
    else if (c.outcome === "error")
      parts.push(`<div class="bodystatus">Error${c.reason ? `: ${escapeHtml(c.reason)}` : ""}.</div><div class="taskact">${removeBtn(c)}</div>`);
    const detail = detailLines(c);
    if (detail) parts.push(`<div class="capdetail">${detail}</div>`);
    parts.push(`<div class="taskmeta">${escapeHtml([relTime(c.ts), urlPath(c.url), `${c.stats.console}c·${c.stats.network}n`].filter(Boolean).join(" · "))}</div>`);
    return parts.join("");
  };

  const taskRowHtml = (c: CaptureRecord): string => {
    const open = expanded.has(c.id);
    return `<div class="task ${rowClass(c)}">
      <div class="taskhead" data-toggle="${escapeHtml(c.id)}">
        <span class="pip"></span>
        <span class="tasktext">${escapeHtml(rowText(c))}</span>
        <span class="taskhint">${rowHint(c)}</span>
      </div>
      <div class="taskbody" ${open ? "" : "hidden"}>${rowBody(c)}</div>
    </div>`;
  };

  // Wire the per-row controls in a container (used for both the main list and the archive).
  // The toggle is on the head; the action buttons live in the body (a sibling), so clicking an
  // action never toggles the row.
  const wireRows = (container: HTMLElement) => {
    container.querySelectorAll("[data-toggle]").forEach((h) =>
      h.addEventListener("click", () => {
        const id = (h as HTMLElement).dataset.toggle;
        if (!id) return;
        if (expanded.has(id)) expanded.delete(id);
        else expanded.add(id);
        renderTasks();
      }),
    );
    container.querySelectorAll("[data-run]").forEach((b) =>
      b.addEventListener("click", () => {
        const id = (b as HTMLElement).dataset.run;
        if (id) options.onRun?.(id);
      }),
    );
    container.querySelectorAll("[data-remove]").forEach((b) =>
      b.addEventListener("click", () => {
        const id = (b as HTMLElement).dataset.remove;
        if (!id) return;
        options.onRemove(id); // daemon drops the record + inbox item; we drop the row optimistically
        expanded.delete(id);
        tasks = tasks.filter((x) => x.id !== id);
        renderTasks();
      }),
    );
    container.querySelectorAll("[data-insist]").forEach((b) =>
      b.addEventListener("click", () => {
        const t = tasks.find((x) => x.id === (b as HTMLElement).dataset.insist);
        if (t) options.onSubmit(t.transcript, true);
      }),
    );
  };

  // Running first (pinned at top), then newest first. So the current work is always on top.
  const sortedTasks = (): CaptureRecord[] =>
    [...tasks].sort((a, b) => {
      const ar = isRunning(a) ? 1 : 0;
      const br = isRunning(b) ? 1 : 0;
      return ar !== br ? br - ar : b.ts - a.ts;
    });

  const renderArchive = () => {
    if (!archivedTasks.length) {
      arcTasksEl.innerHTML = `<p class="taskempty">Nothing archived.</p>`;
      return;
    }
    arcTasksEl.innerHTML = archivedTasks.map(taskRowHtml).join("");
    wireRows(arcTasksEl);
  };

  // The pinned bottom zone. The composer (text + mic) stays available in every mode except while
  // you are editing an instruction, so you can always kick off another capture, even while a
  // previous one is still summarizing. On top of it sits a contextual bar: a "Drafting…" indicator
  // while summarizing, or Ship / Edit / Discard once a draft is ready to review.
  const renderComposer = () => {
    const pending = tasks.filter((t) => t.outcome === "drafted").sort((a, b) => b.ts - a.ts)[0];
    const drafting = !pending && tasks.some((t) => t.outcome === "capturing");
    const mode = editing ? "editing" : pending ? "review" : drafting ? "drafting" : "compose";
    composerEl.hidden = mode === "editing"; // available while composing, drafting, and reviewing
    reviewBar.hidden = mode !== "review";
    draftingBar.hidden = mode !== "drafting";
    editBar.hidden = mode !== "editing";
    if (mode === "review" && pending) {
      const fb = pending.feedbackId ?? "";
      reviewBar.innerHTML = `<div class="reviewintent">${escapeHtml(pending.intent || pending.transcript)}</div>
        <div class="reviewact">
          <button class="send" data-ship>Ship to agent</button>
          <button type="button" class="draftbtn ghost" data-editintent>Edit</button>
          <button type="button" class="draftbtn ghost" data-discarddraft>Discard</button>
        </div>`;
      reviewBar.querySelector("[data-ship]")?.addEventListener("click", () => options.onApprove(fb));
      reviewBar.querySelector("[data-editintent]")?.addEventListener("click", () => {
        editing = { feedbackId: fb };
        editTa.value = pending.intent || pending.transcript;
        const detail = draftDetail.get(fb)?.feedback;
        editAssertions.value = JSON.stringify(detail?.assertions ?? [], null, 2);
        renderComposer();
        setTimeout(() => editTa.focus(), 0);
      });
      reviewBar.querySelector("[data-discarddraft]")?.addEventListener("click", () => {
        options.onRemove(pending.id);
        expanded.delete(pending.id);
        tasks = tasks.filter((x) => x.id !== pending.id);
        renderTasks();
      });
    }
    if (mode === "compose" || mode === "review") updateSend();
  };

  // The minimized launcher's dot reflects fix status: orange + throbbing while the agent works,
  // blue when it landed, red when it did not; otherwise it shows the connection state.
  const updateLauncherDot = () => {
    dot.classList.remove("working", "fixed", "failed");
    const newest = tasks.reduce<CaptureRecord | undefined>((a, b) => (!a || b.ts > a.ts ? b : a), undefined);
    if (tasks.some(isRunning)) dot.classList.add("working");
    else if (newest?.outcome === "fixed") dot.classList.add("fixed");
    else if (newest?.outcome === "failed") dot.classList.add("failed");
  };

  const renderTasks = () => {
    const sorted = sortedTasks();
    const visible = sorted.slice(0, VISIBLE);
    archivedTasks = sorted.slice(VISIBLE);
    arcBtn.hidden = archivedTasks.length === 0;
    arcCount.textContent = archivedTasks.length ? String(archivedTasks.length) : "";
    if (!archivedTasks.length) panel.classList.remove("archive-open");
    tasksEl.innerHTML = visible.length ? visible.map(taskRowHtml).join("") : `<p class="taskempty">Flag something and it shows up here.</p>`;
    wireRows(tasksEl);
    if (panel.classList.contains("archive-open")) renderArchive();
    ensureTicker();
    renderComposer();
    updateLauncherDot();
  };

  const upsertCapture = (record: CaptureRecord) => {
    const i = tasks.findIndex((t) => t.id === record.id);
    const prev = i === -1 ? undefined : tasks[i];
    if (i === -1) tasks.unshift(record);
    else tasks[i] = record;
    // A review auto-expands when it's drafted; once it's approved/resolved, collapse it back.
    if (prev?.outcome === "drafted" && record.outcome !== "drafted") expanded.delete(record.id);
    renderTasks();
  };

  const removeCapture = (captureId: string) => {
    if (!tasks.some((t) => t.id === captureId)) return;
    expanded.delete(captureId);
    tasks = tasks.filter((t) => t.id !== captureId);
    renderTasks();
  };

  return {
    showStatus(text: string) {
      statusEl.textContent = text;
    },
    setConnected(connected: boolean) {
      dot.classList.toggle("on", connected);
      updateLauncherDot();
    },
    upsertCapture,
    removeCapture,
    seedTasks(captures: CaptureRecord[]) {
      // Seed from the daemon's persisted history, but keep any newer rows we already have live.
      const known = new Set(tasks.map((t) => t.id));
      tasks = [...tasks, ...captures.filter((c) => !known.has(c.id))];
      tasks.sort((a, b) => b.ts - a.ts);
      renderTasks();
    },
    showDraft(feedback: Feedback, attachments?: { console: ConsoleEntry[]; network: NetworkEntry[] }) {
      // Stash the full drafted detail (repro + receipts) for the row's expandable body. The review
      // itself (intent + Ship / Edit / Discard) is the pinned bottom bar, so no auto-expand needed.
      draftDetail.set(feedback.id, { feedback, attachments });
      renderTasks();
      setOpen(true);
    },
    clearInput() {
      ta.value = "";
      updateSend();
    },
    setAmbient(proposals: AmbientProposal[]) {
      ambientCount.hidden = proposals.length === 0;
      ambientCount.textContent = String(proposals.length);
      ambientEl.replaceChildren(...proposals.map((proposal) => {
        const item = document.createElement("div");
        item.className = "ambientitem";
        const text = document.createElement("div");
        text.textContent = `${proposal.summary} (${proposal.count}×)`;
        const actions = document.createElement("div");
        actions.className = "ambientactions";
        const promote = document.createElement("button");
        promote.textContent = "Review task";
        promote.onclick = () => options.onAmbientPromote?.(proposal.fingerprint);
        const dismiss = document.createElement("button");
        dismiss.textContent = "Dismiss";
        dismiss.onclick = () => options.onAmbientDismiss?.(proposal.fingerprint);
        actions.append(promote, dismiss);
        item.append(text, actions);
        return item;
      }));
    },
    setDrafting(drafting?: { provider: string; model: string; baseUrl?: string }, error?: string) {
      if (drafting) {
        // Map an arbitrary provider name to a seg option (custom OpenAI-compatible ones show as "openai").
        draftProvider = MODELS.some((m) => m.id === drafting.provider) ? drafting.provider : "openai";
        modelName.value = drafting.model;
        if (drafting.baseUrl) modelBaseUrl.value = drafting.baseUrl;
        renderModel();
      }
      modelHint.textContent = error ? `Error: ${error}` : drafting ? `Using ${drafting.provider} · ${drafting.model}.` : "";
    },
    open() {
      setOpen(true);
    },
    onReady(daemonSelection?: DeliverySelection, project?: string) {
      // Now that we know which project this daemon serves, load THAT project's saved gear
      // choice. A saved choice is authoritative for its own project: push it so the daemon
      // routes to match. Otherwise adopt whatever the daemon reports as its current routing.
      if (project) deliveryKey = `heckle:delivery:${project}`;
      if (!hasDeliveryPref && deliveryKey) {
        try {
          const saved = localStorage.getItem(deliveryKey);
          if (saved) {
            delivery = { ...DEFAULT_DELIVERY, ...JSON.parse(saved) };
            hasDeliveryPref = true;
          }
        } catch {
          // ignore bad storage
        }
      }
      if (hasDeliveryPref) {
        saveDeliveryPref(); // a gear choice made before ready now has a key to live under
        renderDelivery();
        options.onSetDelivery?.(delivery);
      } else if (daemonSelection) {
        delivery = daemonSelection;
        renderDelivery();
      }
    },
  };
}

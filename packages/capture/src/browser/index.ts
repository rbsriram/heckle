// Capture entry point. Wires the buffers, rrweb recorder, transport, and widget together,
// then mounts. Called by the loader with the daemon origin. Idempotent.
import type { ServerMessage } from "@heckle/shared";
import { installConsoleCapture, installFetchCapture, RingBuffer } from "./buffers.ts";
import { assembleContext, type CaptureBuffers } from "./context.ts";
import { startRrwebRecording } from "./recorder.ts";
import { captureTarget, installPointerTracking } from "./target.ts";
import { connect } from "./transport.ts";
import { createWidget } from "./widget.ts";

export async function start(origin: string): Promise<void> {
  const w = window as Window & { __heckleStarted?: boolean };
  if (w.__heckleStarted) return;
  w.__heckleStarted = true;

  const buffers: CaptureBuffers = {
    console: new RingBuffer(200),
    network: new RingBuffer(100),
    rrweb: new RingBuffer(800),
  };
  installConsoleCapture(buffers.console);
  // Do not record Heckle's own daemon traffic (/config, /transcribe) into the app capture.
  installFetchCapture(buffers.network, globalThis, (url) => url.startsWith(origin));
  startRrwebRecording(buffers.rrweb);
  // Track what the user points at, so "change this" / "move that" resolves to a real element.
  const pointer: { el: Element | null; at: number } = { el: null, at: 0 };
  installPointerTracking(pointer);

  const wsUrl = origin.replace(/^http/, "ws") + "/ws";

  // Learn the active voice provider so the mic button behaves correctly (local dictation
  // vs in-browser Web Speech). Default to local on any failure.
  let voiceProvider = "local";
  let sttAvailable = false;
  let configOk = true;
  try {
    const cfg = (await (await fetch(`${origin}/config`)).json()) as {
      voice?: { provider?: string };
      sttAvailable?: boolean;
    };
    voiceProvider = cfg.voice?.provider ?? "local";
    sttAvailable = !!cfg.sttAvailable;
  } catch {
    configOk = false; // daemon /config unreachable; text capture still works, voice is off
  }

  // Send recorded audio to the daemon's local Parakeet worker, get text back.
  const transcribe = async (wav: Blob): Promise<string> => {
    const res = await fetch(`${origin}/transcribe`, {
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: wav,
    });
    if (!res.ok) throw new Error(`transcribe HTTP ${res.status}`);
    const json = (await res.json()) as { text?: string; error?: string };
    if (json.error) throw new Error(json.error);
    return json.text ?? "";
  };

  const widget = createWidget({
    voiceProvider,
    sttAvailable,
    onVoice: transcribe,
    onSubmit(text, insist) {
      const selection = captureTarget(pointer);
      const context = assembleContext(buffers, { url: location.href, selection });
      transport.send({ type: "trigger", intentText: text, context, insist });
      widget.showStatus(insist ? "Insisting, drafting…" : "Capturing…");
    },
    onApprove(feedbackId, edited) {
      transport.send({ type: "approve", feedbackId, edited });
      widget.showStatus("Sending to your agent…");
    },
    onRun(captureId) {
      transport.send({ type: "run", captureId });
      widget.showStatus("Running it with your agent…");
    },
    onRemove(captureId) {
      transport.send({ type: "remove", captureId });
    },
    onSetDelivery(selection) {
      transport.send({ type: "setDelivery", selection });
    },
    onSetConfig(cfg) {
      transport.send({ type: "setConfig", ...cfg });
    },
  });

  // Degrade loudly, never silently: if voice cannot work, say why so a missing mic is never
  // a mystery. Capture and typing are unaffected, so the user is informed, not stuck.
  const notice = !configOk
    ? "Heckle daemon unreachable. Typing still works."
    : voiceProvider === "local" && !sttAvailable
      ? "Voice unavailable (local model not running). Type your note instead."
      : "";
  if (notice) widget.showStatus(notice);

  const transport = connect(wsUrl, {
    onOpen: () => widget.setConnected(true),
    onClose: () => widget.setConnected(false),
    onMessage: (msg: ServerMessage) => {
      switch (msg.type) {
        case "ready":
          widget.setConnected(true);
          widget.onReady(msg.delivery, msg.project);
          widget.setDrafting(msg.drafting);
          transport.send({ type: "history" }); // seed the task list from the persisted captures
          break;
        case "config":
          widget.setDrafting(msg.drafting, msg.error);
          break;
        case "ack":
          widget.showStatus(
            `Captured. ${msg.stats.console} console, ${msg.stats.network} network, ${msg.stats.rrweb} events. Drafting...`,
          );
          break;
        case "draft":
          // The task row is created by the capture push; this adds its full detail + Approve.
          widget.showDraft(msg.feedback, msg.attachments);
          break;
        case "noissue":
          widget.showStatus(msg.reason ? `Nothing to flag: ${msg.reason}` : "Nothing to flag.");
          break;
        case "delivered": {
          // Only claim an agent is on it when a dispatch adapter actually fired; in inbox-only
          // routing (or with the agent CLI unavailable) no fixStatus will ever arrive.
          const dispatched = msg.results.some(
            (r) => r.ok && (r.adapter === "claude-code" || r.adapter === "cursor" || r.adapter === "codex"),
          );
          widget.showStatus(
            dispatched ? "Shipped. The agent is on it." : "Saved to .heckle/inbox.md. Run “check Heckle” when ready.",
          );
          widget.clearInput();
          break;
        }
        case "fixStatus":
          // The task row already shows Fixed / Didn't-land; this is just the top-line echo.
          widget.showStatus(msg.ok ? "Fixed. Reload the page to see it." : "Didn’t land. Check the dispatch log.");
          break;
        case "capture":
          widget.upsertCapture(msg.record);
          break;
        case "removed":
          widget.removeCapture(msg.captureId);
          break;
        case "history":
          widget.seedTasks(msg.captures);
          break;
        case "error":
          widget.showStatus(`Error: ${msg.message}`);
          break;
      }
    },
  });

  console.log("[heckle] capture attached →", origin);
}

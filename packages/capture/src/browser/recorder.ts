// rrweb DOM/event recording into a ring buffer. rrweb is loaded as a UMD global by the
// loader; if it is unavailable, capture degrades gracefully to console + network only.
import type { RingBuffer } from "./buffers.ts";

interface RrwebGlobal {
  record?: (opts: { emit: (event: unknown) => void; sampling?: unknown; recordCanvas?: boolean }) => (() => void) | undefined;
}

export function startRrwebRecording(buffer: RingBuffer<unknown>): () => void {
  const rr = (globalThis as { rrweb?: RrwebGlobal }).rrweb;
  if (!rr || typeof rr.record !== "function") {
    console.warn("[heckle] rrweb unavailable, DOM recording off (console + network capture still active)");
    return () => {};
  }
  const stop = rr.record({
    emit: (event) => buffer.push(event),
    sampling: { mousemove: 200, scroll: 200, input: "last" },
    recordCanvas: false,
  });
  return typeof stop === "function" ? stop : () => {};
}

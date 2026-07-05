// Assemble a ContextBundle snapshot from the live capture buffers. Pure, testable in Node.
import type { ConsoleEntry, ContextBundle, NetworkEntry, PointedTarget } from "@heckle/shared";
import type { RingBuffer } from "./buffers.ts";

export interface CaptureBuffers {
  console: RingBuffer<ConsoleEntry>;
  network: RingBuffer<NetworkEntry>;
  rrweb: RingBuffer<unknown>;
}

export function assembleContext(
  buffers: CaptureBuffers,
  meta: { url: string; flow?: string; selection?: PointedTarget },
): ContextBundle {
  return {
    url: meta.url,
    flow: meta.flow,
    console: buffers.console.snapshot(),
    network: buffers.network.snapshot(),
    rrwebEvents: buffers.rrweb.snapshot(),
    selection: meta.selection,
    capturedAt: Date.now(),
  };
}

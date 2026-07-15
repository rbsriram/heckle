// Assemble a ContextBundle snapshot from the live capture buffers. Pure, testable in Node.
import type { ConsoleEntry, ContextBundle, NetworkEntry, PointedTarget, ReproStateSeed } from "../../../shared/src/index.ts";
import type { RingBuffer } from "./buffers.ts";
import type { ActionLog } from "./actions.ts";

export interface CaptureBuffers {
  console: RingBuffer<ConsoleEntry>;
  network: RingBuffer<NetworkEntry>;
  rrweb: RingBuffer<unknown>;
  actions: ActionLog;
  stateSeed: ReproStateSeed;
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
    viewport: {
      width: typeof innerWidth === "number" ? innerWidth : 1280,
      height: typeof innerHeight === "number" ? innerHeight : 720,
    },
    stateSeed: structuredClone(buffers.stateSeed),
    actions: buffers.actions.snapshot(),
    capturedAt: Date.now(),
  };
}

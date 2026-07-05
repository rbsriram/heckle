// Pure capture primitives: ring buffers + console/network patching.
// No DOM access at import time, so this module is unit-testable directly in Node.
import type { ConsoleEntry, ConsoleLevel, NetworkEntry } from "@heckle/shared";

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return prefix + counter.toString(36);
}

/** Fixed-capacity buffer keeping the most recent `max` items. */
export class RingBuffer<T> {
  private items: T[] = [];
  private max: number;

  constructor(max: number) {
    this.max = max;
  }

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.max) this.items.shift();
  }

  snapshot(): T[] {
    return this.items.slice();
  }

  clear(): void {
    this.items = [];
  }

  get size(): number {
    return this.items.length;
  }
}

const LEVELS: ConsoleLevel[] = ["log", "info", "warn", "error", "debug"];

/** Patch console methods to mirror entries into `buffer`. Returns a restore function. */
export function installConsoleCapture(buffer: RingBuffer<ConsoleEntry>, target: Console = console): () => void {
  const original: Partial<Record<ConsoleLevel, (...args: unknown[]) => void>> = {};
  for (const level of LEVELS) {
    const fn = (target as unknown as Record<string, unknown>)[level];
    if (typeof fn !== "function") continue;
    const bound = (fn as (...a: unknown[]) => void).bind(target);
    original[level] = bound;
    (target as unknown as Record<string, unknown>)[level] = (...args: unknown[]) => {
      buffer.push({ id: nextId("c"), level, args: args.map(safeStringify), ts: Date.now() });
      bound(...args);
    };
  }
  return () => {
    for (const level of LEVELS) {
      if (original[level]) (target as unknown as Record<string, unknown>)[level] = original[level];
    }
  };
}

interface FetchRoot {
  fetch?: typeof fetch;
}

/**
 * Wrap fetch to record request/response metadata into `buffer`. Returns a restore function.
 * `ignore` skips matching URLs (used to keep Heckle's own daemon traffic out of the capture).
 */
export function installFetchCapture(
  buffer: RingBuffer<NetworkEntry>,
  root: FetchRoot = globalThis,
  ignore?: (url: string) => boolean,
): () => void {
  const originalFetch = root.fetch;
  if (typeof originalFetch !== "function") return () => {};

  root.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : isRequest(input) ? input.url : String(input);
    if (ignore?.(url)) return originalFetch(input, init); // Heckle's own plumbing, do not record
    const start = Date.now();
    const id = nextId("n");
    const method = init?.method ?? (isRequest(input) ? input.method : "GET");
    try {
      const res = await originalFetch(input, init);
      buffer.push({ id, method, url, status: res.status, ok: res.ok, durationMs: Date.now() - start, ts: start });
      return res;
    } catch (err) {
      buffer.push({ id, method, url, ok: false, durationMs: Date.now() - start, ts: start });
      throw err;
    }
  };
  return () => {
    root.fetch = originalFetch;
  };
}

function isRequest(x: unknown): x is Request {
  return typeof x === "object" && x !== null && "url" in x && "method" in x;
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

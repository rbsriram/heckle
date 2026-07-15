// Pure capture primitives: ring buffers + console/network patching.
// No DOM access at import time, so this module is unit-testable directly in Node.
import type { ConsoleEntry, ConsoleLevel, NetworkEntry } from "../../../shared/src/index.ts";

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

const SENSITIVE_BODY_KEY = /(?:auth|token|secret|password|passwd|session|cookie|jwt|api[-_]?key|email)/i;

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, SENSITIVE_BODY_KEY.test(key) ? "[REDACTED]" : redactValue(item)]),
    );
  }
  return value;
}

function redactBody(body: string): string {
  try {
    return JSON.stringify(redactValue(JSON.parse(body)));
  } catch {
    const params = new URLSearchParams(body);
    if (body.includes("=") && [...params.keys()].length) {
      for (const key of [...params.keys()]) if (SENSITIVE_BODY_KEY.test(key)) params.set(key, "[REDACTED]");
      return params.toString();
    }
    return body
      .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [REDACTED]")
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]");
  }
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
    let requestBody: string | undefined;
    try {
      if (typeof init?.body === "string") requestBody = redactBody(init.body.slice(0, 100_000));
      else if (init?.body instanceof URLSearchParams) requestBody = redactBody(init.body.toString().slice(0, 100_000));
      else if (isRequest(input)) {
        const text = (await input.clone().text()).slice(0, 100_000);
        requestBody = text ? redactBody(text) : undefined;
      }
    } catch {}
    try {
      const res = await originalFetch(input, init);
      let responseBody: string | undefined;
      const contentType = res.headers.get("content-type") ?? "";
      if (!/(?:image|audio|video|font|zip|octet-stream)/i.test(contentType)) {
        try {
          const text = (await res.clone().text()).slice(0, 100_000);
          responseBody = text ? redactBody(text) : undefined;
        } catch {}
      }
      buffer.push({
        id,
        method,
        url,
        status: res.status,
        ok: res.ok,
        durationMs: Date.now() - start,
        requestBody,
        responseBody,
        responseHeaders: Object.fromEntries(res.headers.entries()),
        ts: start,
      });
      return res;
    } catch (err) {
      buffer.push({ id, method, url, ok: false, durationMs: Date.now() - start, requestBody, ts: start });
      throw err;
    }
  };
  return () => {
    root.fetch = originalFetch;
  };
}

export function installXhrCapture(
  buffer: RingBuffer<NetworkEntry>,
  ignore?: (url: string) => boolean,
): () => void {
  if (typeof XMLHttpRequest === "undefined") return () => {};
  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  const meta = new WeakMap<XMLHttpRequest, { method: string; url: string; ts: number; body?: string }>();
  XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: unknown[]) {
    const href = String(url);
    meta.set(this, { method: method.toUpperCase(), url: href, ts: Date.now() });
    return open.call(
      this,
      method,
      href,
      rest.length === 0 ? true : Boolean(rest[0]),
      rest[1] as string | undefined,
      rest[2] as string | undefined,
    );
  };
  XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
    const current = meta.get(this);
    if (current && typeof body === "string") current.body = redactBody(body.slice(0, 100_000));
    const done = () => {
      this.removeEventListener("loadend", done);
      const entry = meta.get(this);
      if (!entry || ignore?.(entry.url)) return;
      let responseBody: string | undefined;
      try {
        if (this.responseType === "" || this.responseType === "text") {
          const text = this.responseText.slice(0, 100_000);
          responseBody = text ? redactBody(text) : undefined;
        }
      } catch {}
      buffer.push({
        id: nextId("n"),
        method: entry.method,
        url: entry.url,
        status: this.status || undefined,
        ok: this.status >= 200 && this.status < 400,
        durationMs: Date.now() - entry.ts,
        requestBody: entry.body,
        responseBody,
        responseHeaders: this.getResponseHeader("content-type")
          ? { "content-type": this.getResponseHeader("content-type")! }
          : undefined,
        ts: entry.ts,
      });
    };
    this.addEventListener("loadend", done);
    return send.call(this, body);
  };
  return () => {
    XMLHttpRequest.prototype.open = open;
    XMLHttpRequest.prototype.send = send;
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

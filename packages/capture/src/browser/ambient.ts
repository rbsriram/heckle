import type { AmbientSignal, ConsoleEntry, ContextBundle, NetworkEntry, ReproAction } from "../../../shared/src/index.ts";

interface AmbientOptions {
  route: () => string;
  origin?: () => string;
  context: () => ContextBundle;
  actions: () => ReproAction[];
  ignore?: string[];
  dismissed?: (fingerprint: string) => boolean;
  emit: (signal: AmbientSignal) => void;
}

function template(value: string): string {
  return value
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<id>")
    .replace(/\b\d+(?:\.\d+)?\b/g, "<n>")
    .replace(/https?:\/\/[^\s)]+/g, "<url>")
    .replace(/\s+/g, " ")
    .trim();
}

function topFrame(stack?: string): string {
  return stack?.split("\n").map((line) => line.trim()).find((line) => /^at\s/.test(line)) ?? "";
}

export function ambientFingerprint(summary: string, route: string, stack?: string): string {
  return `${template(summary)}|${template(topFrame(stack))}|${route}`;
}

export class AmbientDetector {
  private readonly options: AmbientOptions;
  private readonly counts = new Map<string, number>();
  private readonly proposed = new Set<string>();

  constructor(options: AmbientOptions) {
    this.options = options;
  }

  observeConsole(entry: ConsoleEntry): void {
    if (entry.level !== "error") return;
    this.observe("console", entry.args.join(" "), entry.stack, entry.ts);
  }

  observeException(message: string, stack?: string, kind: "exception" | "rejection" = "exception", ts = Date.now()): void {
    this.observe(kind, message, stack, ts);
  }

  observeNetwork(entry: NetworkEntry): void {
    if ((entry.status ?? 0) < 400) return;
    let url: URL;
    try {
      url = new URL(entry.url, this.options.origin?.() ?? location.href);
    } catch {
      return;
    }
    if (url.origin !== new URL(this.options.origin?.() ?? location.href).origin) return;
    if ((this.options.ignore ?? []).some((part) => entry.url.includes(part))) return;
    this.observe("network", `${entry.method} ${url.pathname} -> ${entry.status}`, undefined, entry.ts);
  }

  observePerformance(summary: string, ts = Date.now()): void {
    this.observe("performance", summary, undefined, ts);
  }

  private observe(kind: AmbientSignal["kind"], summary: string, stack?: string, ts = Date.now()): void {
    const route = this.options.route();
    const fingerprint = ambientFingerprint(summary, route, stack);
    const count = (this.counts.get(fingerprint) ?? 0) + 1;
    this.counts.set(fingerprint, count);
    const userVisible = this.options.actions().some((action) => action.type === "click" && ts - action.ts >= 0 && ts - action.ts <= 2_000);
    const shouldPropose = !this.proposed.has(fingerprint)
      && !this.options.dismissed?.(fingerprint)
      && (count >= 2 || userVisible);
    if (shouldPropose) this.proposed.add(fingerprint);
    let context: ContextBundle | undefined;
    if (shouldPropose) {
      context = this.options.context();
      const actions = this.options.actions();
      const window = actions.filter((action) => action.ts <= ts && action.ts >= ts - 30_000);
      const priorGoto = actions.slice(0, actions.findLastIndex((action) => action.ts <= ts && action.type === "goto") + 1)
        .findLast((action) => action.type === "goto");
      context.actions = priorGoto && !window.includes(priorGoto) ? [priorGoto, ...window] : window;
      context.capturedAt = ts;
    }
    this.options.emit({
      fingerprint,
      kind,
      summary,
      route,
      count,
      userVisible,
      context,
    });
  }
}

export function installGlobalErrorCapture(detector: AmbientDetector): () => void {
  const onError = (event: ErrorEvent) => detector.observeException(event.message, event.error?.stack);
  const onRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    detector.observeException(reason instanceof Error ? reason.message : String(reason), reason instanceof Error ? reason.stack : undefined, "rejection");
  };
  addEventListener("error", onError);
  addEventListener("unhandledrejection", onRejection);
  return () => {
    removeEventListener("error", onError);
    removeEventListener("unhandledrejection", onRejection);
  };
}

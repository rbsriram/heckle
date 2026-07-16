// Capture what the user is pointing at when they flag something: highlighted text and/or the
// element under their last click. This is what lets a note like "change this" or "move that"
// resolve to a concrete element, so the draft targets it instead of guessing. Heckle's own UI
// is always ignored.
import type { PointedTarget, ReproTarget, SourceLocation } from "../../../shared/src/index.ts";

const HECKLE_HOST_ID = "heckle-root";

// Resolve a DOM element back to the markup that rendered it, so "call it Go Pro" or "make it
// darker" can become a one-line source edit instead of a full agent round trip. Each framework
// exposes a source location in dev differently; we try each in turn. Best-effort and dev-only:
// any failure returns undefined and the daemon falls back to grepping source for the literal,
// then to the normal draft-and-dispatch path. Nothing here is React-specific except one adapter.

// React: the dev jsx-source transform stamps `_debugSource` on the fiber (React <=18) or a
// `__source` prop (present whenever the transform ran). Walk up from the DOM node's fiber.
function reactSource(el: Element): SourceLocation | undefined {
  const key = Object.keys(el).find(
    (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"),
  );
  let fiber: any = key ? (el as unknown as Record<string, unknown>)[key] : null;
  let hops = 0;
  while (fiber && hops < 40) {
    const s = fiber._debugSource ?? fiber.memoizedProps?.__source ?? fiber.pendingProps?.__source;
    if (s && typeof s.fileName === "string" && typeof s.lineNumber === "number") {
      return {
        file: s.fileName,
        line: s.lineNumber,
        column: typeof s.columnNumber === "number" ? s.columnNumber : undefined,
      };
    }
    fiber = fiber.return;
    hops++;
  }
  return undefined;
}

// Svelte: dev builds attach `__svelte_meta.loc = { file, line, column }` to each element.
function svelteSource(el: Element): SourceLocation | undefined {
  let node: Element | null = el;
  let hops = 0;
  while (node && hops < 40) {
    const loc = (node as any).__svelte_meta?.loc;
    if (loc && typeof loc.file === "string" && typeof loc.line === "number") {
      return { file: loc.file, line: loc.line, column: typeof loc.column === "number" ? loc.column : undefined };
    }
    node = node.parentElement;
    hops++;
  }
  return undefined;
}

// Vue: vite-plugin-vue-inspector stamps `data-v-inspector="path:line:col"`. Failing that, the dev
// component instance carries its SFC path in `type.__file` (file only, no line).
function vueSource(el: Element): SourceLocation | undefined {
  const tagged = typeof el.closest === "function" ? el.closest("[data-v-inspector]") : null;
  const raw = tagged?.getAttribute("data-v-inspector");
  const m = raw?.match(/^(.*):(\d+):(\d+)$/);
  if (m) return { file: m[1], line: Number(m[2]), column: Number(m[3]) };
  let node: any = el;
  let hops = 0;
  while (node && hops < 40) {
    const file = node.__vueParentComponent?.type?.__file;
    if (typeof file === "string") return { file };
    node = node.parentElement;
    hops++;
  }
  return undefined;
}

function resolveSource(el: Element): SourceLocation | undefined {
  try {
    const tagged = el.closest("[data-heckle-src]")?.getAttribute("data-heckle-src");
    const match = tagged?.match(/^(.*):(\d+):(\d+)$/);
    if (match) return { file: match[1], line: Number(match[2]), column: Number(match[3]) };
    return reactSource(el) ?? svelteSource(el) ?? vueSource(el);
  } catch {
    // Framework internals vary; never let source resolution break capture.
    return undefined;
  }
}

export function withinHeckle(el: Element | null): boolean {
  if (!el) return false;
  if (el.id === HECKLE_HOST_ID) return true;
  return typeof el.closest === "function" && el.closest(`#${HECKLE_HOST_ID}`) !== null;
}

// A stable-ish CSS selector for an element: prefer #id, else a short tag/class/nth path.
export function cssPath(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  let depth = 0;
  while (node && node.nodeType === 1 && depth < 4) {
    if (node.id) {
      parts.unshift(`#${CSS.escape(node.id)}`);
      break;
    }
    let sel = node.tagName.toLowerCase();
    sel += Array.from(node.classList)
      .slice(0, 2)
      .map((c) => `.${CSS.escape(c)}`)
      .join("");
    const parent: Element | null = node.parentElement;
    if (parent) {
      const sibs = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
      if (sibs.length > 1) sel += `:nth-of-type(${sibs.indexOf(node) + 1})`;
    }
    parts.unshift(sel);
    node = parent;
    depth++;
  }
  return parts.join(" > ");
}

function implicitRole(el: Element): string | undefined {
  const tag = el.tagName.toLowerCase();
  if (tag === "button") return "button";
  if (tag === "a" && el.hasAttribute("href")) return "link";
  if (tag === "textarea") return "textbox";
  if (tag === "select") return "combobox";
  if (tag === "input") {
    const type = (el.getAttribute("type") ?? "text").toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (["button", "submit", "reset"].includes(type)) return "button";
    return "textbox";
  }
  return undefined;
}

function accessibleName(el: Element): string | undefined {
  const aria = el.getAttribute("aria-label")?.trim();
  if (aria) return aria;
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const label = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
      .filter(Boolean)
      .join(" ");
    if (label) return label;
  }
  const value = (el as HTMLInputElement).value?.trim();
  if (value && ["INPUT", "BUTTON"].includes(el.tagName)) return value;
  return el.textContent?.trim().replace(/\s+/g, " ").slice(0, 200) || undefined;
}

export function targetForElement(el: Element): ReproTarget {
  return {
    testid: el.getAttribute("data-testid") ?? undefined,
    role: el.getAttribute("role") ?? implicitRole(el),
    name: accessibleName(el),
    css: cssPath(el),
  };
}

// A short human-readable description, e.g. <button.cta> "Subscribe".
function describe(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : "";
  const cls = el.classList.length ? `.${Array.from(el.classList).slice(0, 2).join(".")}` : "";
  const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
  return `<${tag}${id}${cls}>${text ? ` "${text}"` : ""}`;
}

// A click older than this is not what the user means by "this": a report typed minutes after
// the last click is about something else, and a stale selector would misdirect the fix.
export const POINTED_RECENCY_MS = 120_000;

export interface PointerState {
  el: Element | null;
  at: number; // epoch ms of the click that set el
}

// Remember the last element the user clicked (ignoring Heckle's own UI). Pass a shared holder
// so the caller can read the latest value at capture time.
export function installPointerTracking(state: PointerState): void {
  document.addEventListener(
    "pointerdown",
    (e) => {
      const t = e.target as Element | null;
      if (t && !withinHeckle(t)) {
        state.el = t;
        state.at = Date.now();
      }
    },
    true,
  );
}

// Snapshot the pointed target at capture time: highlighted text + the relevant element. Prefers
// a live text selection's element, else a RECENT last-clicked element. Returns undefined if neither.
export function captureTarget(pointer: PointerState): PointedTarget | undefined {
  const sel = typeof window.getSelection === "function" ? window.getSelection() : null;
  const text = sel && !sel.isCollapsed ? sel.toString().trim().slice(0, 500) : "";
  let el: Element | null = null;
  if (text && sel && sel.anchorNode) {
    const a = sel.anchorNode;
    el = a.nodeType === 1 ? (a as Element) : a.parentElement;
  }
  if (!el && pointer.el && Date.now() - pointer.at <= POINTED_RECENCY_MS) el = pointer.el;
  if (withinHeckle(el)) el = null;
  if (!text && !el) return undefined;
  const targetText = el
    ? (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 200) || undefined
    : undefined;
  const siblings = el?.parentElement ? [...el.parentElement.children] : [];
  return {
    text: text || undefined,
    selector: el ? cssPath(el) : undefined,
    label: el ? describe(el) : undefined,
    target: el ? targetForElement(el) : undefined,
    parentTarget: el?.parentElement ? targetForElement(el.parentElement) : undefined,
    source: el ? resolveSource(el) : undefined,
    targetText,
    className: el?.getAttribute("class") ?? undefined,
    inlineStyle: el instanceof HTMLElement
      ? Object.fromEntries([...el.style].map((property) => [property, el.style.getPropertyValue(property)]))
      : undefined,
    siblingIndex: el ? siblings.indexOf(el) : undefined,
    siblingTexts: siblings.map((sibling) => (sibling.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 100)),
  };
}

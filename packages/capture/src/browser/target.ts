// Capture what the user is pointing at when they flag something: highlighted text and/or the
// element under their last click. This is what lets a note like "change this" or "move that"
// resolve to a concrete element, so the draft targets it instead of guessing. Heckle's own UI
// is always ignored.
import type { PointedTarget } from "@heckle/shared";

const HECKLE_HOST_ID = "heckle-root";

function withinHeckle(el: Element | null): boolean {
  if (!el) return false;
  if (el.id === HECKLE_HOST_ID) return true;
  return typeof el.closest === "function" && el.closest(`#${HECKLE_HOST_ID}`) !== null;
}

// A stable-ish CSS selector for an element: prefer #id, else a short tag/class/nth path.
function cssPath(el: Element): string {
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
  return {
    text: text || undefined,
    selector: el ? cssPath(el) : undefined,
    label: el ? describe(el) : undefined,
  };
}

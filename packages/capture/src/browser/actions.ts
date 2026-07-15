import type { ReproAction } from "../../../shared/src/index.ts";
import { targetForElement, withinHeckle } from "./target.ts";

const STORAGE_KEY = "__heckle_actions_v1";

export class ActionLog {
  private actions: ReproAction[] = [];
  private readonly capacity: number;

  constructor(capacity = 50) {
    this.capacity = capacity;
    try {
      const stored = typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(STORAGE_KEY);
      if (stored) this.actions = (JSON.parse(stored) as ReproAction[]).slice(-capacity);
    } catch {}
  }

  private persist(): void {
    try {
      if (typeof sessionStorage !== "undefined") sessionStorage.setItem(STORAGE_KEY, JSON.stringify(this.actions));
    } catch {}
  }

  push(action: ReproAction): void {
    const previous = this.actions[this.actions.length - 1];
    if (
      action.type === "fill" &&
      previous?.type === "fill" &&
      JSON.stringify(previous.target) === JSON.stringify(action.target)
    ) {
      this.actions[this.actions.length - 1] = action;
      this.persist();
      return;
    }
    this.actions.push(action);
    if (this.actions.length > this.capacity) this.actions.shift();
    this.persist();
  }

  snapshot(): ReproAction[] {
    return this.actions.map((action) => structuredClone(action));
  }
}

export function installActionCapture(log: ActionLog): () => void {
  const recordGoto = () => log.push({ type: "goto", url: location.href, ts: Date.now() });
  recordGoto();

  const click = (event: Event) => {
    const element = event.target instanceof Element ? event.target : null;
    if (!element || withinHeckle(element)) return;
    log.push({ type: "click", target: targetForElement(element), ts: Date.now() });
  };
  const input = (event: Event) => {
    const element = event.target;
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) return;
    if (withinHeckle(element)) return;
    const target = targetForElement(element);
    if (element instanceof HTMLSelectElement) {
      log.push({ type: "select", target, value: element.value, ts: Date.now() });
    } else if (element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio")) {
      log.push({ type: "check", target, checked: element.checked, ts: Date.now() });
    } else {
      log.push({ type: "fill", target, value: element.value, ts: Date.now() });
    }
  };
  const keydown = (event: KeyboardEvent) => {
    const element = event.target instanceof Element ? event.target : null;
    if (!element || withinHeckle(element) || !["Enter", "Escape", "Tab"].includes(event.key)) return;
    log.push({ type: "press", target: targetForElement(element), value: event.key, ts: Date.now() });
  };

  document.addEventListener("click", click, true);
  document.addEventListener("input", input, true);
  document.addEventListener("change", input, true);
  document.addEventListener("keydown", keydown, true);
  window.addEventListener("popstate", recordGoto);
  window.addEventListener("hashchange", recordGoto);

  const pushState = history.pushState;
  const replaceState = history.replaceState;
  history.pushState = function (...args) {
    const result = pushState.apply(this, args);
    recordGoto();
    return result;
  };
  history.replaceState = function (...args) {
    const result = replaceState.apply(this, args);
    recordGoto();
    return result;
  };

  return () => {
    document.removeEventListener("click", click, true);
    document.removeEventListener("input", input, true);
    document.removeEventListener("change", input, true);
    document.removeEventListener("keydown", keydown, true);
    window.removeEventListener("popstate", recordGoto);
    window.removeEventListener("hashchange", recordGoto);
    history.pushState = pushState;
    history.replaceState = replaceState;
  };
}

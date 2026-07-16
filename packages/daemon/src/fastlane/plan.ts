import type { PointedTarget } from "../../../shared/src/index.ts";
import type { AstEditRequest } from "./ast-edit.ts";

const COLOR = /\b(red|blue|green|black|white|gray|grey|yellow|orange|purple|pink|teal|cyan|violet|indigo)\b/i;

export function planStyleEdit(transcript: string, target?: PointedTarget): AstEditRequest | undefined {
  if (!target?.source?.file || !target.source.line) return undefined;
  const base = { file: target.source.file, line: target.source.line };
  if (/\bmove\b.*\b(?:before|up|left)\b/i.test(transcript) && (target.siblingIndex ?? 0) > 0) {
    return { ...base, operation: { kind: "reorder", fromIndex: target.siblingIndex!, toIndex: target.siblingIndex! - 1 } };
  }
  if (/\bmove\b.*\b(?:after|down|right)\b/i.test(transcript) && target.siblingIndex !== undefined && target.siblingIndex < (target.siblingTexts?.length ?? 0) - 1) {
    return { ...base, operation: { kind: "reorder", fromIndex: target.siblingIndex, toIndex: target.siblingIndex + 1 } };
  }
  if (/\bhide\b|\binvisible\b/i.test(transcript)) return { ...base, operation: { kind: "visibility", hidden: true } };
  if (/\bshow\b|\bvisible\b/i.test(transcript)) return { ...base, operation: { kind: "visibility", hidden: false } };
  const color = transcript.match(COLOR)?.[1].toLowerCase().replace("grey", "gray");
  if (color) {
    if (target.inlineStyle?.color) return { ...base, operation: { kind: "style", property: "color", newValue: color } };
    if (/background/i.test(transcript) && target.inlineStyle?.["background-color"]) {
      return { ...base, operation: { kind: "style", property: "backgroundColor", newValue: color } };
    }
    const tokens = target.className?.split(/\s+/) ?? [];
    const prefix = /background/i.test(transcript) ? "bg" : /border/i.test(transcript) ? "border" : "text";
    const old = tokens.find((token) => token.startsWith(`${prefix}-`));
    const shade = old?.match(/-(\d{2,3})$/)?.[1] ?? "500";
    return { ...base, operation: { kind: "class-token", oldValue: old ?? "", newValue: `${prefix}-${color}-${shade}` } };
  }
  if (/\b(?:bold|bolder)\b/i.test(transcript)) {
    const old = target.className?.split(/\s+/).find((token) => /^font-(?:thin|light|normal|medium|semibold|bold|black)$/.test(token));
    return { ...base, operation: { kind: "class-token", oldValue: old ?? "", newValue: "font-bold" } };
  }
  if (/\bround(?:ed)?\b/i.test(transcript)) {
    const old = target.className?.split(/\s+/).find((token) => /^rounded(?:-|$)/.test(token));
    return { ...base, operation: { kind: "class-token", oldValue: old ?? "", newValue: "rounded-lg" } };
  }
  if (/\b(?:bigger|larger)\b/i.test(transcript)) {
    const old = target.className?.split(/\s+/).find((token) => /^text-(?:xs|sm|base|lg|xl|\d+xl)$/.test(token));
    return { ...base, operation: { kind: "class-token", oldValue: old ?? "", newValue: "text-lg" } };
  }
  if (/\b(?:smaller)\b/i.test(transcript)) {
    const old = target.className?.split(/\s+/).find((token) => /^text-(?:xs|sm|base|lg|xl|\d+xl)$/.test(token));
    return { ...base, operation: { kind: "class-token", oldValue: old ?? "", newValue: "text-sm" } };
  }
  return undefined;
}

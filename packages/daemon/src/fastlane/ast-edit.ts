import { promises as fs } from "node:fs";
import { relative } from "node:path";
import ts from "typescript";
import { resolveUnderRoot } from "./locate.ts";

export type AstEditOperation =
  | { kind: "text"; oldValue: string; newValue: string }
  | { kind: "class-token"; oldValue?: string; newValue: string }
  | { kind: "style"; property: string; newValue: string | number }
  | { kind: "visibility"; hidden: boolean }
  | { kind: "reorder"; fromIndex: number; toIndex: number };

export interface AstEditRequest {
  file: string;
  line: number;
  operation: AstEditOperation;
}

export interface AstEditResult {
  ok: boolean;
  file: string;
  reason?: string;
  before?: string;
  after?: string;
  preview?: string;
  durationMs: number;
}

function opening(node: ts.Node): ts.JsxOpeningLikeElement | undefined {
  if (ts.isJsxElement(node)) return node.openingElement;
  if (ts.isJsxSelfClosingElement(node)) return node;
  return undefined;
}

function targetElement(source: ts.SourceFile, line: number): ts.JsxElement | ts.JsxSelfClosingElement | undefined {
  const candidates: Array<ts.JsxElement | ts.JsxSelfClosingElement> = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) candidates.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return candidates
    .filter((node) => {
      const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const end = source.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
      return line >= start && line <= end;
    })
    .sort((a, b) => a.getWidth(source) - b.getWidth(source))[0];
}

function replacementFor(source: ts.SourceFile, target: ts.JsxElement | ts.JsxSelfClosingElement, operation: AstEditOperation): { start: number; end: number; text: string } | string {
  const open = opening(target)!;
  if (operation.kind === "text") {
    if (!ts.isJsxElement(target)) return "target-has-no-text";
    const text = target.children.find((child): child is ts.JsxText => ts.isJsxText(child) && child.getText(source).trim() === operation.oldValue);
    if (!text) return "text-literal-not-found";
    const raw = text.getText(source);
    const start = text.getStart(source) + raw.indexOf(operation.oldValue);
    return { start, end: start + operation.oldValue.length, text: operation.newValue };
  }
  if (operation.kind === "class-token") {
    const attribute = open.attributes.properties.find((item): item is ts.JsxAttribute => ts.isJsxAttribute(item) && item.name.getText(source) === "className");
    if (!attribute) {
      if (!operation.oldValue) return { start: open.tagName.getEnd(), end: open.tagName.getEnd(), text: ` className=${JSON.stringify(operation.newValue)}` };
      return "className-is-not-a-string-literal";
    }
    if (!attribute.initializer || !ts.isStringLiteral(attribute.initializer)) return "className-is-not-a-string-literal";
    const tokens = attribute.initializer.text.split(/\s+/).filter(Boolean);
    if (operation.oldValue) {
      const index = tokens.indexOf(operation.oldValue);
      if (index === -1) return "class-token-not-found";
      tokens[index] = operation.newValue;
    } else {
      tokens.push(operation.newValue);
    }
    return { start: attribute.initializer.getStart(source) + 1, end: attribute.initializer.getEnd() - 1, text: tokens.join(" ") };
  }
  if (operation.kind === "style") {
    const attribute = open.attributes.properties.find((item): item is ts.JsxAttribute => ts.isJsxAttribute(item) && item.name.getText(source) === "style");
    if (!attribute?.initializer || !ts.isJsxExpression(attribute.initializer)) return "style-is-not-an-object-literal";
    const expression = attribute.initializer.expression;
    if (!expression || !ts.isObjectLiteralExpression(expression)) return "style-is-not-an-object-literal";
    const property = expression.properties.find((item): item is ts.PropertyAssignment => ts.isPropertyAssignment(item) && item.name.getText(source).replace(/["']/g, "") === operation.property);
    if (!property || (!ts.isStringLiteral(property.initializer) && !ts.isNumericLiteral(property.initializer))) return "style-value-is-not-literal";
    return {
      start: property.initializer.getStart(source),
      end: property.initializer.getEnd(),
      text: typeof operation.newValue === "number" ? String(operation.newValue) : JSON.stringify(operation.newValue),
    };
  }
  if (operation.kind === "visibility") {
    const hidden = open.attributes.properties.find((item): item is ts.JsxAttribute => ts.isJsxAttribute(item) && item.name.getText(source) === "hidden");
    if (operation.hidden) {
      if (hidden) return "already-hidden";
      return { start: open.tagName.getEnd(), end: open.tagName.getEnd(), text: " hidden" };
    }
    if (!hidden) return "not-hidden";
    let start = hidden.getStart(source);
    while (start > open.tagName.getEnd() && /\s/.test(source.text[start - 1])) start--;
    return { start, end: hidden.getEnd(), text: "" };
  }
  let container: ts.JsxElement | undefined = ts.isJsxElement(target) ? target : undefined;
  while (container && container.children.filter((child) => ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)).length < 2) {
    container = ts.isJsxElement(container.parent) ? container.parent : undefined;
  }
  if (!container) return "reorder-target-is-not-an-element";
  const children = container.children.filter((child) => ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child));
  if (children.length < 2 || operation.fromIndex < 0 || operation.toIndex < 0 || operation.fromIndex >= children.length || operation.toIndex >= children.length) return "invalid-static-sibling-order";
  if (container.children.some((child) => ts.isJsxExpression(child))) return "dynamic-sibling-list";
  const ordered = [...children];
  const [moved] = ordered.splice(operation.fromIndex, 1);
  ordered.splice(operation.toIndex, 0, moved);
  const separator = source.text.slice(children[0].getEnd(), children[1].getStart(source));
  return {
    start: children[0].getStart(source),
    end: children.at(-1)!.getEnd(),
    text: ordered.map((child) => child.getText(source)).join(separator),
  };
}

export async function applyAstEdit(root: string, request: AstEditRequest, options: { dryRun?: boolean } = {}): Promise<AstEditResult> {
  const started = performance.now();
  const file = resolveUnderRoot(root, request.file);
  if (!file) return { ok: false, file: request.file, reason: "outside-root", durationMs: performance.now() - started };
  const before = await fs.readFile(file, "utf8");
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.JSX;
  const source = ts.createSourceFile(file, before, ts.ScriptTarget.Latest, true, kind);
  const diagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length) return { ok: false, file, reason: "source-has-parse-errors", durationMs: performance.now() - started };
  const target = targetElement(source, request.line);
  if (!target) return { ok: false, file, reason: "source-element-not-found", durationMs: performance.now() - started };
  const replacement = replacementFor(source, target, request.operation);
  if (typeof replacement === "string") return { ok: false, file, reason: replacement, durationMs: performance.now() - started };
  const after = before.slice(0, replacement.start) + replacement.text + before.slice(replacement.end);
  if (after === before) return { ok: false, file, reason: "no-change", durationMs: performance.now() - started };
  const parsedAfter = ts.createSourceFile(file, after, ts.ScriptTarget.Latest, true, kind);
  const afterDiagnostics = (parsedAfter as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (afterDiagnostics.length) return { ok: false, file, reason: "edit-would-break-parse", durationMs: performance.now() - started };
  if (!options.dryRun) {
    if (await fs.readFile(file, "utf8") !== before) return { ok: false, file, reason: "file-changed-during-edit", durationMs: performance.now() - started };
    const temporary = `${file}.heckle-${process.pid}.tmp`;
    await fs.writeFile(temporary, after, "utf8");
    await fs.rename(temporary, file);
  }
  return {
    ok: true,
    file,
    before,
    after,
    preview: `${request.operation.kind} · ${relative(root, file)}:${request.line}`,
    durationMs: performance.now() - started,
  };
}

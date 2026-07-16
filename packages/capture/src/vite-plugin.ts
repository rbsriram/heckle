// Ambient auto-attach for Vite projects. Add `heckle()` to your vite.config plugins and
// the widget injects itself into the dev server's HTML whenever you run under `heckle dev`
// (which sets HECKLE_DAEMON_URL). No separate step; if Heckle isn't running, nothing injects.
// No `vite` import, we only return Vite's plugin shape, consumed by the user's Vite.
import ts from "typescript";
import { relative } from "node:path";

interface IndexHtmlTag {
  tag: string;
  attrs?: Record<string, string>;
  injectTo?: "head" | "body" | "head-prepend" | "body-prepend";
}

interface VitePluginLike {
  name: string;
  apply?: "serve" | "build";
  transformIndexHtml: (html: string) => { html: string; tags: IndexHtmlTag[] };
  transform: (code: string, id: string) => { code: string; map: null } | null;
}

export function injectSourceLocations(code: string, id: string, projectRoot = process.cwd()): string {
  const kind = id.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.JSX;
  const source = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true, kind);
  const rel = relative(projectRoot, id).replaceAll("\\", "/");
  const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
    const visit: ts.Visitor = (node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        if (!node.attributes.properties.some((property) => ts.isJsxAttribute(property) && property.name.getText(source) === "data-heckle-src")) {
          const position = source.getLineAndCharacterOfPosition(node.getStart(source));
          const attribute = ts.factory.createJsxAttribute(
            ts.factory.createIdentifier("data-heckle-src"),
            ts.factory.createStringLiteral(`${rel}:${position.line + 1}:${position.character + 1}`),
          );
          const attributes = ts.factory.updateJsxAttributes(node.attributes, [...node.attributes.properties, attribute]);
          return ts.isJsxOpeningElement(node)
            ? ts.factory.updateJsxOpeningElement(node, node.tagName, node.typeArguments, attributes)
            : ts.factory.updateJsxSelfClosingElement(node, node.tagName, node.typeArguments, attributes);
        }
      }
      return ts.visitEachChild(node, visit, context);
    };
    return (file) => ts.visitNode(file, visit) as ts.SourceFile;
  };
  const result = ts.transform(source, [transformer]);
  try {
    return ts.createPrinter().printFile(result.transformed[0]);
  } finally {
    result.dispose();
  }
}

export function heckle(opts: { daemonUrl?: string } = {}): VitePluginLike {
  const daemonUrl = opts.daemonUrl ?? process.env.HECKLE_DAEMON_URL ?? "http://127.0.0.1:4317";
  return {
    name: "heckle",
    apply: "serve", // dev only, never inject into production builds
    transform(code, id) {
      if (!/\.[jt]sx(?:\?|$)/.test(id) || id.includes("node_modules")) return null;
      return { code: injectSourceLocations(code, id.split("?", 1)[0]), map: null };
    },
    transformIndexHtml(html) {
      return {
        html,
        tags: [{ tag: "script", attrs: { src: `${daemonUrl}/heckle.js` }, injectTo: "body" }],
      };
    },
  };
}

export default heckle;

const ts = require("typescript");
const path = require("node:path");

module.exports = function heckleSourceLoader(code) {
  const source = ts.createSourceFile(this.resourcePath, code, ts.ScriptTarget.Latest, true, this.resourcePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.JSX);
  const rel = path.relative(this.rootContext, this.resourcePath).replaceAll("\\", "/");
  const transformer = (context) => {
    const visit = (node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        if (!node.attributes.properties.some((property) => ts.isJsxAttribute(property) && property.name.getText(source) === "data-heckle-src")) {
          const position = source.getLineAndCharacterOfPosition(node.getStart(source));
          const attribute = ts.factory.createJsxAttribute(ts.factory.createIdentifier("data-heckle-src"), ts.factory.createStringLiteral(`${rel}:${position.line + 1}:${position.character + 1}`));
          const attributes = ts.factory.updateJsxAttributes(node.attributes, [...node.attributes.properties, attribute]);
          return ts.isJsxOpeningElement(node)
            ? ts.factory.updateJsxOpeningElement(node, node.tagName, node.typeArguments, attributes)
            : ts.factory.updateJsxSelfClosingElement(node, node.tagName, node.typeArguments, attributes);
        }
      }
      return ts.visitEachChild(node, visit, context);
    };
    return (file) => ts.visitNode(file, visit);
  };
  const result = ts.transform(source, [transformer]);
  try {
    return ts.createPrinter().printFile(result.transformed[0]);
  } finally {
    result.dispose();
  }
};

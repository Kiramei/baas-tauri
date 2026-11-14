import ts from "typescript";

/** Compares interpolation names while allowing translators to repeat or reorder them. */
export function interpolationNames(text) {
  return [
    ...new Set(
      [...String(text).matchAll(/\{\{\s*-?\s*([\w.]+)(?:\s*,[^}]*)?\s*\}\}/g)].map(
        (match) => match[1]
      )
    ),
  ].sort();
}

export function placeholderErrors(catalogs, referenceLanguage = "en") {
  const errors = [];
  const reference = catalogs[referenceLanguage];
  for (const [language, catalog] of Object.entries(catalogs)) {
    for (const [key, value] of Object.entries(catalog)) {
      if (!(key in reference)) continue;
      const expected = interpolationNames(reference[key]);
      const actual = interpolationNames(value);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        errors.push(
          `${language}.${key} interpolation names differ: expected [${expected}], received [${actual}]`
        );
      }
    }
  }
  return errors;
}

const uiNames = new Set([
  "aria-label",
  "aria-description",
  "title",
  "alt",
  "placeholder",
  "label",
  "description",
  "ariaLabel",
]);
const notificationCall =
  /^(?:toast|notice)\.(?:success|error|info|warning|message|loading)$|^(?:alert|confirm|prompt)$/;

/** Finds authored UI literals; backend values, translation calls, and CSS are never rewritten. */
export function auditUiText(
  sourceText,
  filename,
  { translationKeys = new Set(), allowedLiterals = {} } = {}
) {
  const source = ts.createSourceFile(
    filename,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    /\.[tj]sx$/.test(filename) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const issues = new Map();
  const declarations = new Map();
  function remember(name, declaration) {
    const values = declarations.get(name) ?? [];
    values.push(declaration);
    declarations.set(name, values);
  }
  function index(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      remember(node.name.text, node);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "map"
    ) {
      const callback = node.arguments[0];
      if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
        const parameter = callback.parameters[0];
        if (parameter && ts.isIdentifier(parameter.name)) {
          remember(parameter.name.text, {
            parent: callback,
            initializer: node.expression.expression,
          });
        }
      }
    }
    ts.forEachChild(node, index);
  }
  index(source);
  const ancestors = (node) => {
    const result = new Set();
    for (; node; node = node.parent) result.add(node);
    return result;
  };
  function declarationFor(identifier) {
    const parents = ancestors(identifier);
    return declarations.get(identifier.text)?.findLast((declaration) => {
      let scope = declaration.parent;
      while (scope && !ts.isBlock(scope) && !ts.isSourceFile(scope) && !ts.isFunctionLike(scope))
        scope = scope.parent;
      return parents.has(scope);
    });
  }
  function report(node, value, metadata = false) {
    const text = value.replace(/\s+/g, " ").trim();
    const exemption = allowedLiterals[text];
    const exempt =
      typeof exemption === "string" ||
      (typeof exemption?.reason === "string" && exemption.files?.includes(filename));
    if (
      !/\p{L}/u.test(text) ||
      /^#[a-f\d]{3,8}$/i.test(text) ||
      (metadata && translationKeys.has(text)) ||
      exempt
    )
      return;
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    issues.set(`${line}:${text}`, { file: filename, line, text });
  }
  function inspect(node, visited = new Set(), metadata = false) {
    if (!node || visited.has(node)) return;
    visited = new Set(visited).add(node);
    if (ts.isStringLiteralLike(node) || ts.isJsxText(node)) report(node, node.text, metadata);
    else if (ts.isTemplateExpression(node)) {
      report(node, node.head.text, metadata);
      for (const span of node.templateSpans) {
        inspect(span.expression, visited, metadata);
        report(span.literal, span.literal.text, metadata);
      }
    } else if (ts.isConditionalExpression(node)) {
      inspect(node.whenTrue, visited, metadata);
      inspect(node.whenFalse, visited, metadata);
    } else if (ts.isBinaryExpression(node)) {
      if (node.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken)
        inspect(node.left, visited, metadata);
      inspect(node.right, visited, metadata);
    } else if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node)
    ) {
      inspect(node.expression, visited, metadata);
    } else if (ts.isIdentifier(node)) {
      inspect(declarationFor(node)?.initializer, visited, metadata);
    } else if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) inspect(element, visited, metadata);
    } else if (ts.isElementAccessExpression(node)) {
      const initializer = ts.isIdentifier(node.expression)
        ? declarationFor(node.expression)?.initializer
        : node.expression;
      if (initializer && ts.isArrayLiteralExpression(initializer))
        inspect(initializer, visited, metadata);
      else if (initializer && ts.isObjectLiteralExpression(initializer)) {
        for (const property of initializer.properties)
          if (ts.isPropertyAssignment(property)) inspect(property.initializer, visited, metadata);
      }
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "join"
    ) {
      inspect(node.expression.expression, visited, metadata);
      for (const argument of node.arguments) inspect(argument, visited, metadata);
    }
  }
  function walk(node) {
    if (
      ts.isJsxElement(node) &&
      ["style", "script"].includes(node.openingElement.tagName.getText(source))
    )
      return;
    if (ts.isJsxText(node)) inspect(node);
    if (ts.isJsxAttribute(node) && uiNames.has(node.name.getText(source))) {
      const value = node.initializer;
      if (value && ts.isJsxExpression(value)) inspect(value.expression);
      else inspect(value);
    }
    if (ts.isJsxExpression(node) && !ts.isJsxAttribute(node.parent)) inspect(node.expression);
    if (
      ts.isPropertyAssignment(node) &&
      uiNames.has(node.name.getText(source).replace(/^['"]|['"]$/g, ""))
    )
      inspect(node.initializer, new Set(), true);
    if (ts.isCallExpression(node) && notificationCall.test(node.expression.getText(source)))
      inspect(node.arguments[0]);
    ts.forEachChild(node, walk);
  }
  walk(source);
  return [...issues.values()];
}

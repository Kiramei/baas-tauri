import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { CONFIGURATION_SECTIONS } from "../../src/shared/ConfigurationSections";
import coverage from "../evidence/configuration-coverage.json";

const root = new URL("../../", import.meta.url);

function draftFields(source: string): string[] {
  const ast = ts.createSourceFile(
    "editor.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  let fields: string[] | undefined;
  let initial: ts.VariableDeclaration | undefined;
  function visit(node: ts.Node) {
    if (
      (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
      node.name.text === "Draft"
    ) {
      const members = ts.isInterfaceDeclaration(node)
        ? node.members
        : ts.isTypeLiteralNode(node.type)
          ? node.type.members
          : undefined;
      if (!members) throw new Error("Unrecognized Draft shape; review the coverage checker");
      fields = members.map((member) => member.name!.getText(ast));
    }
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "initial") initial = node;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (fields) return fields;
  // Total Assault uses an inferred inline object instead of a named Draft.
  if (initial?.initializer && ts.isCallExpression(initial.initializer)) {
    const factory = initial.initializer.arguments[0];
    if (factory && ts.isArrowFunction(factory)) {
      let body = factory.body;
      while (ts.isParenthesizedExpression(body)) body = body.expression;
      if (ts.isObjectLiteralExpression(body)) {
        return body.properties.map((property) => property.name!.getText(ast));
      }
    }
    throw new Error("Unrecognized initial shape; review the coverage checker");
  }
  return [];
}

test("configuration audit covers every registered category and current editor draft field", () => {
  expect(coverage.sections.map((section) => section.id).sort()).toEqual(
    CONFIGURATION_SECTIONS.map((section) => section.id).sort()
  );
  for (const section of coverage.sections) {
    const source = readFileSync(new URL(section.source, root), "utf8");
    expect(draftFields(source).sort(), section.id).toEqual(Object.keys(section.fields).sort());
    for (const locale of ["en", "zh"]) {
      const document = readFileSync(
        new URL("docs/content/docs/" + locale + "/" + section.page + ".mdx", root),
        "utf8"
      );
      for (const mention of Object.values(section.fields)) {
        expect(document, locale + "/" + section.id + ": " + mention).toContain(mention);
      }
      for (const command of "commands" in section ? section.commands : []) {
        expect(source).toContain('"' + command + '"');
        expect(document, locale + "/" + section.id).toContain(command);
      }
      expect(document).not.toMatch(/src="\/(?:cn|en)\/.*settings\.png"/);
    }
  }
});

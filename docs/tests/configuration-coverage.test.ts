import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { CONFIGURATION_SECTIONS } from "../../src/shared/ConfigurationSections";
import coverage from "../evidence/configuration-coverage.json";

const root = new URL("../../", import.meta.url);
const configPath = fileURLToPath(new URL("tsconfig.json", root));
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, fileURLToPath(root));
if (parsed.errors.length)
  throw new Error("The configuration audit could not read the project types");
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();

/** Inspect the actual saved draft, including imported models and helper return types. */
function draftFields(path: string): string[] {
  const ast = program.getSourceFile(fileURLToPath(new URL(path, root)));
  if (!ast) throw new Error("Configuration editor source is missing: " + path);
  const fields = new Set<string>();
  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "useConfigurationDraft"
    ) {
      const initial = node.arguments[2];
      if (!initial) throw new Error("Configuration draft has no initial value: " + path);
      const model = checker.getTypeAtLocation(initial);
      const properties = checker.getPropertiesOfType(model);
      if (model.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) || !properties.length)
        throw new Error("Cannot resolve the saved draft's fields: " + path);
      for (const property of properties) fields.add(property.getName());
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return [...fields];
}

test("configuration audit covers every registered category and current editor draft field", () => {
  expect(coverage.sections.map((section) => section.id).sort()).toEqual(
    CONFIGURATION_SECTIONS.map((section) => section.id).sort()
  );
  for (const section of coverage.sections) {
    const source = readFileSync(new URL(section.source, root), "utf8");
    expect(draftFields(section.source).sort(), section.id).toEqual(
      Object.keys(section.fields).sort()
    );
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

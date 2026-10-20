import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import audit from "../evidence/workspaces-coverage.json";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const document = (locale: string, page: string) =>
  read("docs/content/docs/" + locale + "/" + page + ".mdx");
const ast = (source: string) =>
  ts.createSourceFile("source.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function labelledInputs(source: string): string[] {
  const file = ast(source);
  const labels = new Set<string>();
  function visit(node: ts.Node) {
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(file) === "label" &&
      node.initializer &&
      ts.isJsxExpression(node.initializer)
    ) {
      const value = node.initializer.expression;
      if (
        value &&
        ts.isCallExpression(value) &&
        value.expression.getText(file) === "t" &&
        value.arguments[0] &&
        ts.isStringLiteral(value.arguments[0])
      )
        labels.add(value.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return [...labels].sort();
}

function registeredIds(source: string, variable: string): string[] {
  const file = ast(source);
  const ids: string[] = [];
  function visit(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(file) === variable &&
      node.initializer
    ) {
      let expression = node.initializer;
      while (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression))
        expression = expression.expression;
      if (!ts.isArrayLiteralExpression(expression))
        throw new Error("Review changed registry shape");
      for (const item of expression.elements) {
        if (!ts.isObjectLiteralExpression(item)) throw new Error("Review changed registry entry");
        const id = item.properties.find(
          (property) => ts.isPropertyAssignment(property) && property.name.getText(file) === "id"
        );
        if (!id || !ts.isPropertyAssignment(id) || !ts.isStringLiteral(id.initializer))
          throw new Error("Registry ID must be reviewed");
        ids.push(id.initializer.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (!ids.length) throw new Error("Registry was not found");
  return ids.sort();
}

test("every registered settings category and statically labelled control has bilingual coverage", () => {
  expect(registeredIds(read("src/shared/SettingsSections.ts"), "SETTINGS_SECTIONS")).toEqual(
    audit.sections.map(({ id }) => id).sort()
  );
  expect(labelledInputs(read("src/pages/SettingsPage.tsx"))).toEqual(
    Object.keys(audit.settingsLabels).sort()
  );
  for (const locale of ["en", "zh"] as const) {
    for (const section of audit.sections)
      expect(document(locale, "features/system")).toContain("## " + section[locale]);
    for (const { page, mention } of Object.values(audit.settingsLabels))
      expect(document(locale, page)).toContain(mention);
    for (const field of audit.additionalSettings)
      expect(document(locale, "features/system")).toContain(field);
  }
});

test("application shortcut IDs and remote input labels stay aligned with the audited guide", () => {
  expect(
    registeredIds(read("src/shared/ApplicationShortcuts.ts"), "APPLICATION_SHORTCUTS")
  ).toEqual([...audit.applicationShortcutIds].sort());
  expect(labelledInputs(read("src/components/RemoteDisplay.tsx"))).toEqual(
    Object.keys(audit.remoteLabels).sort()
  );
  for (const locale of ["en", "zh"]) {
    for (const id of audit.applicationShortcutIds)
      expect(document(locale, "features/system")).toContain("\x60" + id + "\x60");
    for (const field of Object.values(audit.remoteLabels))
      expect(document(locale, "features/home-runtime")).toContain(field);
  }
});

test("developer archive ownership names the profile commands present in the current client", () => {
  const source = read("src/components/layout/Header.tsx");
  for (const command of audit.profileCommands) {
    expect(source).toContain('"' + command + '"');
    for (const locale of ["en", "zh"])
      expect(document(locale, "reference/client-architecture")).toContain(command);
  }
});

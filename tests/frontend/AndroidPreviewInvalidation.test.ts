import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { invalidatesAndroidPreview } from "../../src/shared/AndroidPreviewInvalidation";

const node = (blocker = false, descendant = false, ancestor = false) =>
  ({
    nodeType: 1,
    matches: () => blocker,
    querySelector: () => (descendant ? {} : null),
    closest: () => (blocker || ancestor ? {} : null),
  }) as unknown as Element;
const mutation = (target: Node, overrides = {}) =>
  ({
    type: "childList",
    target,
    addedNodes: [],
    removedNodes: [],
    ...overrides,
  }) as unknown as MutationRecord;

test("log text, token classes and row churn do not invalidate native layout", () => {
  expect(
    invalidatesAndroidPreview([
      mutation(node(), { addedNodes: [node(), { nodeType: 3 }], removedNodes: [node()] }),
      mutation(node(), { type: "attributes", attributeName: "class" }),
      mutation(node(), { type: "characterData" }),
    ])
  ).toBe(false);
});
test("added or removed overlays and containing portal trees invalidate immediately", () => {
  for (const key of ["addedNodes", "removedNodes"]) {
    expect(invalidatesAndroidPreview([mutation(node(), { [key]: [node(true)] })])).toBe(true);
    expect(invalidatesAndroidPreview([mutation(node(), { [key]: [node(false, true)] })])).toBe(
      true
    );
  }
});
test("overlay visibility, descendants and removed explicit markers invalidate", () => {
  for (const target of [node(true), node(false, true), node(false, false, true)]) {
    expect(
      invalidatesAndroidPreview([
        mutation(target, { type: "attributes", attributeName: "aria-hidden" }),
      ])
    ).toBe(true);
  }
  expect(
    invalidatesAndroidPreview([
      mutation(node(), { type: "attributes", attributeName: "data-native-preview-blocker" }),
    ])
  ).toBe(true);
  expect(invalidatesAndroidPreview([mutation(node(true), { addedNodes: [node()] })])).toBe(true);
});
test("only the active profile owns polling; unchanged polls reuse layout", () => {
  const panel = readFileSync(
    new URL("../../src/android/components/AndroidGamePanel.tsx", import.meta.url),
    "utf8"
  );
  expect(panel.match(/if \(!active\) return;/g)?.length).toBe(2);
  expect(panel).toContain("if (!layoutDirty && !lastRequest) return;");
  expect(panel).toContain("if (invalidatesAndroidPreview(records)) schedule();");
  expect(panel).toContain("ancestorVisibility.disconnect()");
  expect(panel).toContain("{ capture: true, passive: true }");
  const home = readFileSync(new URL("../../src/pages/HomePage.tsx", import.meta.url), "utf8");
  const body = home.slice(home.indexOf("const HomePage:"));
  expect(body).not.toContain("const activeLogs = useWebSocketStore");
  expect(body).toContain("useWebSocketStore.getState().logStore");
});

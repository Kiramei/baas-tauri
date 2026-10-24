import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ANDROID_PREVIEW_BLOCKERS } from "../../src/shared/AndroidPreviewInvalidation";

test("profile menus and confirmation dialogs suspend only the native preview", () => {
  const header = readFileSync(
    new URL("../../src/components/layout/Header.tsx", import.meta.url),
    "utf8"
  );
  expect(header).toContain('role="menu"');
  expect(header).toContain("data-native-preview-blocker");
  expect(header).toContain('role="dialog"');
  expect(header).toContain('role="alertdialog"');

  const panel = readFileSync(
    new URL("../../src/android/components/AndroidGamePanel.tsx", import.meta.url),
    "utf8"
  );
  for (const selector of [
    '[role="dialog"]',
    '[role="alertdialog"]',
    "[data-native-preview-blocker]",
  ]) {
    expect(ANDROID_PREVIEW_BLOCKERS).toContain(selector);
  }
  expect(panel).toContain("document.querySelectorAll(ANDROID_PREVIEW_BLOCKERS)");
  expect(panel).toContain("if (updatePending && !disposed) schedule();");
  expect(panel).toMatch(
    /mutations\.observe\(document\.body,\s*\{[\s\S]*?childList:\s*true,[\s\S]*?subtree:\s*true/
  );
  const actionHandler = panel.slice(panel.indexOf("const action = (event: Event)"));
  expect(actionHandler.indexOf("getClientRects().length")).toBeLessThan(
    actionHandler.indexOf('name === "restart"')
  );
  expect(actionHandler).toContain("closest(\"[hidden], [aria-hidden='true']\")");
});

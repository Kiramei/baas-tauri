import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("profile menus and confirmation dialogs suspend only the native preview", () => {
  const header = readFileSync(new URL("../../src/components/layout/Header.tsx", import.meta.url), "utf8");
  expect(header).toContain('role="menu"');
  expect(header).toContain("data-native-preview-blocker");
  expect(header).toContain('role="dialog"');
  expect(header).toContain('role="alertdialog"');

  const panel = readFileSync(new URL("../../src/android/components/AndroidGamePanel.tsx", import.meta.url), "utf8");
  expect(panel).toContain('[role="dialog"], [role="alertdialog"], [data-native-preview-blocker]');
  expect(panel).toContain("if (updatePending && !disposed) schedule();");
  expect(panel).toContain("mutations.observe(document.body, { childList: true, subtree: true });");
});

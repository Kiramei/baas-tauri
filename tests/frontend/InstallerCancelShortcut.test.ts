import { describe, expect, test } from "bun:test";
import { shouldCancelInstallerFromEscape } from "../../src/shared/InstallerCancelShortcut";

const escape = (extra: Partial<KeyboardEvent> = {}) => ({
  key: "Escape",
  defaultPrevented: false,
  repeat: false,
  isComposing: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...extra,
});
const running = { running: true, blocked: false, pending: false };

describe("installer cancel shortcut", () => {
  test("only cancels the running progress screen", () => {
    expect(shouldCancelInstallerFromEscape(escape(), running)).toBe(true);
    expect(shouldCancelInstallerFromEscape(escape(), { ...running, running: false })).toBe(false);
    expect(shouldCancelInstallerFromEscape(escape({ key: "Enter" }), running)).toBe(false);
  });

  test("dialogs, menus, composition and consumed keys keep ownership of Escape", () => {
    expect(shouldCancelInstallerFromEscape(escape(), { ...running, blocked: true })).toBe(false);
    for (const extra of [
      { defaultPrevented: true },
      { isComposing: true },
      { ctrlKey: true },
      { metaKey: true },
      { altKey: true },
      { shiftKey: true },
    ])
      expect(shouldCancelInstallerFromEscape(escape(extra), running)).toBe(false);
  });

  test("a held key or pending cancellation cannot submit another abort", () => {
    expect(shouldCancelInstallerFromEscape(escape({ repeat: true }), running)).toBe(false);
    expect(shouldCancelInstallerFromEscape(escape(), { ...running, pending: true })).toBe(false);
  });
});

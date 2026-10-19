import { describe, expect, test } from "bun:test";
import {
  hasCustomSettingsShortcut,
  settingsShortcutMatches,
  shouldOpenSettingsFromShortcut,
  titlebarShortcutLabels,
} from "../../src/shared/SettingsShortcut";

const key = (extra: Partial<KeyboardEvent> = {}) => ({
  key: ",",
  code: "Comma",
  ctrlKey: true,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  defaultPrevented: false,
  repeat: false,
  isComposing: false,
  ...extra,
});
const context = (extra: Partial<Parameters<typeof shouldOpenSettingsFromShortcut>[1]> = {}) => ({
  mac: false,
  ready: true,
  blocked: false,
  bindings: [],
  ...extra,
});
const reserved = (value: string, mac = false, enabled = true) =>
  hasCustomSettingsShortcut([{ id: "custom", label: "Custom", value, enabled }], mac);

describe("settings menu keyboard shortcut", () => {
  test("uses Ctrl+Comma on Windows and Command+Comma on macOS", () => {
    expect(settingsShortcutMatches(key(), false)).toBe(true);
    expect(settingsShortcutMatches(key(), true)).toBe(false);
    expect(settingsShortcutMatches(key({ ctrlKey: false, metaKey: true }), true)).toBe(true);
    expect(settingsShortcutMatches(key({ ctrlKey: false, metaKey: true }), false)).toBe(false);
    expect(settingsShortcutMatches(key({ key: "、" }), false)).toBe(true);
    expect(settingsShortcutMatches(key({ key: ".", code: "Period" }), false)).toBe(false);
    for (const extra of [{ altKey: true }, { shiftKey: true }, { metaKey: true }])
      expect(settingsShortcutMatches(key(extra), false)).toBe(false);
  });

  test("setup, dialogs, shortcut recording, composition and consumed events keep ownership", () => {
    expect(shouldOpenSettingsFromShortcut(key(), context())).toBe(true);
    expect(shouldOpenSettingsFromShortcut(key(), context({ ready: false }))).toBe(false);
    expect(shouldOpenSettingsFromShortcut(key(), context({ blocked: true }))).toBe(false);
    for (const extra of [{ defaultPrevented: true }, { isComposing: true }, { repeat: true }])
      expect(shouldOpenSettingsFromShortcut(key(extra), context())).toBe(false);
  });

  test("enabled custom bindings reserve physical aliases and platform modifiers", () => {
    for (const value of ["Ctrl+,", " Control + Comma ", "CommandOrControl+,", "CmdOrCtrl+Comma"])
      expect(reserved(value)).toBe(true);
    for (const value of ["Cmd+,", "Meta+Comma", "CommandOrControl+,", "CmdOrCtrl+Comma"])
      expect(reserved(value, true)).toBe(true);
    expect(reserved("Ctrl+,", false, false)).toBe(false);
    expect(reserved("Ctrl+Shift+,")).toBe(false);
    expect(reserved("Ctrl+Alt+,")).toBe(false);
    expect(reserved("Ctrl+Unknown+,")).toBe(false);
    expect(reserved("Cmd+,")).toBe(false);
    expect(reserved("Ctrl+,", true)).toBe(false);
    expect(
      shouldOpenSettingsFromShortcut(
        key(),
        context({
          bindings: [{ id: "custom", label: "Custom", value: "Ctrl+," }],
        })
      )
    ).toBe(false);
  });

  test("displayed edit and view modifiers match the platform's actual shortcuts", () => {
    const windows = titlebarShortcutLabels(false);
    const mac = titlebarShortcutLabels(true);
    expect(windows.redo).toBe("Ctrl+Y");
    expect(mac.redo).toBe("Cmd+Shift+Z");
    expect(windows.settings).toBe("Ctrl+,");
    expect(mac.settings).toBe("Cmd+,");
    expect(mac.sidebar).toBe("Cmd+Shift+S");
    expect(mac.back).toBe("Option+←");
    expect(mac.zoomIn).toBe("Cmd++");
    expect(Object.values(mac).some((label) => label.includes("Ctrl"))).toBe(false);
  });
});

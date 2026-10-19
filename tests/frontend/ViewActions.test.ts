import { describe, expect, test } from "bun:test";
import {
  canToggleWorkspaceSidebar,
  hasCustomViewShortcut,
  normalizeWorkspaceZoom,
  stepWorkspaceZoom,
  viewShortcutFromEvent,
} from "../../src/shared/ViewActions";

const key = (value: string, extra: Partial<KeyboardEvent> = {}) => ({
  key: value,
  code: "",
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...extra,
});
describe("workspace view actions", () => {
  test("Settings disables sidebar actions even on a registered desktop workspace", () => {
    expect(canToggleWorkspaceSidebar(true, true, false)).toBe(true);
    expect(canToggleWorkspaceSidebar(true, true, true)).toBe(false);
    expect(canToggleWorkspaceSidebar(false, true, false)).toBe(false);
    expect(canToggleWorkspaceSidebar(true, false, false)).toBe(false);
    expect(canToggleWorkspaceSidebar(true, false, true)).toBe(false);
    // Unlocking on exit restores the ordinary menu and shortcut availability.
    expect(canToggleWorkspaceSidebar(true, true, false)).toBe(true);
  });
  test("zoom uses Settings range and reaches the next actual choice", () => {
    expect(normalizeWorkspaceZoom(NaN)).toBe(100);
    expect(normalizeWorkspaceZoom(900)).toBe(150);
    expect(stepWorkspaceZoom(85, 1)).toBe(90);
    expect(stepWorkspaceZoom(85, -1)).toBe(80);
    expect(stepWorkspaceZoom(100, 1)).toBe(110);
    expect(stepWorkspaceZoom(100, -1)).toBe(90);
    expect(stepWorkspaceZoom(150, 1)).toBe(150);
    expect(stepWorkspaceZoom(50, -1)).toBe(50);
  });
  test("shortcuts use the platform modifier without taking Alt history or text shortcuts", () => {
    expect(viewShortcutFromEvent(key("S", { ctrlKey: true, shiftKey: true }), false)).toBe(
      "sidebar"
    );
    expect(viewShortcutFromEvent(key("S", { metaKey: true, shiftKey: true }), true)).toBe(
      "sidebar"
    );
    expect(viewShortcutFromEvent(key("b", { ctrlKey: true }), false)).toBeNull();
    expect(viewShortcutFromEvent(key("b", { ctrlKey: true, shiftKey: true }), false)).toBeNull();
    expect(viewShortcutFromEvent(key("ArrowLeft", { altKey: true }), false)).toBeNull();
    expect(viewShortcutFromEvent(key("+", { ctrlKey: true, shiftKey: true }), false)).toBe(
      "zoomIn"
    );
    expect(viewShortcutFromEvent(key("0", { ctrlKey: true }), false)).toBe("resetZoom");
    expect(viewShortcutFromEvent(key("F11"), false)).toBe("fullscreen");
    expect(viewShortcutFromEvent(key("F11", { altKey: true }), false)).toBeNull();
    expect(viewShortcutFromEvent(key("-", { metaKey: true }), false)).toBeNull();
  });
  test("enabled user accelerators reserve view keys, including aliases and shifted plus", () => {
    const reserved = (
      value: string,
      action: Parameters<typeof hasCustomViewShortcut>[0],
      mac = false,
      enabled = true
    ) => hasCustomViewShortcut(action, [{ id: "custom", label: "Custom", value, enabled }], mac);
    expect(reserved("Ctrl+Shift+S", "sidebar")).toBe(true);
    expect(reserved("Ctrl+Shift+S", "sidebar", false, false)).toBe(false);
    expect(reserved("Ctrl+Alt+Shift+S", "sidebar")).toBe(false);
    expect(reserved("Ctrl+Shift+=", "zoomIn")).toBe(true);
    expect(reserved("Ctrl+Plus", "zoomIn")).toBe(true);
    expect(reserved("Ctrl++", "zoomIn")).toBe(true);
    expect(reserved("CommandOrControl+0", "resetZoom")).toBe(true);
    expect(reserved("CmdOrCtrl+0", "resetZoom", true)).toBe(true);
    expect(reserved("F11", "fullscreen")).toBe(true);
    expect(reserved("Ctrl+F11", "fullscreen")).toBe(false);
  });
});

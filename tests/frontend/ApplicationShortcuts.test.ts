import { describe, expect, test } from "bun:test";
import {
  APPLICATION_SHORTCUTS,
  applicationShortcutFromEvent,
  applicationShortcutMatches,
  findApplicationShortcutConflict,
  formatApplicationShortcutLabel,
  normalizeApplicationShortcut,
  resolveApplicationShortcutBindings,
  shortcutDefaults,
  type ApplicationShortcutEvent,
} from "../../src/shared/ApplicationShortcuts";

const key = (
  value: string,
  extra: Partial<ApplicationShortcutEvent> = {}
): ApplicationShortcutEvent => ({
  key: value,
  code: "",
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...extra,
});

describe("application shortcut preferences", () => {
  test("platform defaults cover every editable application action", () => {
    expect(APPLICATION_SHORTCUTS.map(({ id }) => id)).toEqual(Object.keys(shortcutDefaults(false)));
    expect(new Set(APPLICATION_SHORTCUTS.map(({ id }) => id)).size).toBe(10);
    expect(shortcutDefaults(false)).toEqual({
      undo: "Ctrl+Z",
      redo: "Ctrl+Y",
      settings: "Ctrl+,",
      sidebar: "Ctrl+Shift+S",
      back: "Alt+ArrowLeft",
      forward: "Alt+ArrowRight",
      zoomIn: "Ctrl++",
      zoomOut: "Ctrl+-",
      resetZoom: "Ctrl+0",
      fullscreen: "F11",
    });
    expect(shortcutDefaults(true).undo).toBe("Cmd+Z");
    expect(shortcutDefaults(true).redo).toBe("Cmd+Shift+Z");
    expect(shortcutDefaults(true).sidebar).toBe("Cmd+Shift+S");
  });

  test("an absent override inherits a default while an empty override disables it", () => {
    expect(applicationShortcutMatches(key("z", { ctrlKey: true }), "undo", undefined, false)).toBe(
      true
    );
    expect(applicationShortcutMatches(key("z", { ctrlKey: true }), "undo", {}, false)).toBe(true);
    expect(
      applicationShortcutMatches(key("z", { ctrlKey: true }), "undo", { undo: "" }, false)
    ).toBe(false);
    expect(
      resolveApplicationShortcutBindings({ undo: "", redo: "control+alt+R" }, false).undo
    ).toBe("");
    expect(resolveApplicationShortcutBindings({ redo: "control+alt+R" }, false).redo).toBe(
      "Ctrl+Alt+R"
    );
    expect(resolveApplicationShortcutBindings({ settings: "not-a-key" }, false).settings).toBe(
      "Ctrl+,"
    );
  });

  test("a remap removes the old action binding and requires exactly its modifiers", () => {
    const bindings = { undo: "Ctrl+Alt+U" };
    expect(applicationShortcutMatches(key("z", { ctrlKey: true }), "undo", bindings, false)).toBe(
      false
    );
    expect(
      applicationShortcutMatches(key("u", { ctrlKey: true, altKey: true }), "undo", bindings, false)
    ).toBe(true);
    expect(applicationShortcutMatches(key("u", { ctrlKey: true }), "undo", bindings, false)).toBe(
      false
    );
    expect(
      applicationShortcutMatches(
        key("u", { ctrlKey: true, altKey: true, shiftKey: true }),
        "undo",
        bindings,
        false
      )
    ).toBe(false);
    expect(
      applicationShortcutMatches(
        key("u", { ctrlKey: true, altKey: true, metaKey: true }),
        "undo",
        bindings,
        false
      )
    ).toBe(false);
  });

  test("plus aliases, shifted Equal, plain Equal, and keypad Add share one accelerator", () => {
    for (const value of [
      "Ctrl++",
      "Control+Plus",
      "Ctrl+Shift+=",
      "Ctrl+Equal",
      "Ctrl+Shift+Equal",
      "Ctrl+NumpadAdd",
    ]) {
      expect(normalizeApplicationShortcut(value, false)).toBe("Ctrl++");
    }
    for (const event of [
      key("+", { ctrlKey: true, shiftKey: true, code: "Equal" }),
      key("=", { ctrlKey: true, code: "Equal" }),
      key("+", { ctrlKey: true, code: "NumpadAdd" }),
      key("+", { ctrlKey: true, shiftKey: true }),
    ])
      expect(applicationShortcutMatches(event, "zoomIn", undefined, false)).toBe(true);
    expect(
      applicationShortcutMatches(
        key("+", { ctrlKey: true, altKey: true, code: "Equal" }),
        "zoomIn",
        undefined,
        false
      )
    ).toBe(false);
  });

  test("recorded keyboard codes match shifted punctuation and non-Latin character layouts", () => {
    expect(applicationShortcutFromEvent(key("Я", { ctrlKey: true, code: "KeyZ" }), false)).toBe(
      "Ctrl+Z"
    );
    expect(
      applicationShortcutMatches(
        key("Я", { ctrlKey: true, code: "KeyZ" }),
        "undo",
        undefined,
        false
      )
    ).toBe(true);
    expect(
      applicationShortcutMatches(
        key("<", { ctrlKey: true, shiftKey: true, code: "Comma" }),
        "settings",
        { settings: "Ctrl+Shift+Comma" },
        false
      )
    ).toBe(true);
    expect(
      applicationShortcutMatches(
        key(",", { ctrlKey: true, code: "Comma" }),
        "settings",
        undefined,
        false
      )
    ).toBe(true);
    expect(
      applicationShortcutMatches(
        key("-", { ctrlKey: true, code: "NumpadSubtract" }),
        "zoomOut",
        undefined,
        false
      )
    ).toBe(true);
    expect(
      applicationShortcutMatches(
        key("0", { ctrlKey: true, code: "Numpad0" }),
        "resetZoom",
        undefined,
        false
      )
    ).toBe(true);
  });

  test("platform and modifier aliases normalize without interchanging explicit Ctrl and Cmd", () => {
    expect(normalizeApplicationShortcut("CommandOrControl+Z", false)).toBe("Ctrl+Z");
    expect(normalizeApplicationShortcut("CmdOrCtrl+Z", true)).toBe("Cmd+Z");
    expect(normalizeApplicationShortcut("Option+Left", true)).toBe("Alt+ArrowLeft");
    expect(normalizeApplicationShortcut("shift + command + z", true)).toBe("Cmd+Shift+Z");
    expect(applicationShortcutMatches(key("z", { metaKey: true }), "undo", undefined, true)).toBe(
      true
    );
    expect(applicationShortcutMatches(key("z", { ctrlKey: true }), "undo", undefined, true)).toBe(
      false
    );
    expect(applicationShortcutMatches(key("z", { metaKey: true }), "undo", undefined, false)).toBe(
      false
    );
    expect(
      applicationShortcutMatches(
        key("z", { metaKey: true, shiftKey: true }),
        "redo",
        undefined,
        true
      )
    ).toBe(true);
  });

  test("conflicts compare aliases and enabled actions without conflicting with themselves", () => {
    const bindings = shortcutDefaults(false);
    expect(findApplicationShortcutConflict("settings", "control+z", bindings, false)).toBe("undo");
    expect(findApplicationShortcutConflict("undo", "control+z", bindings, false)).toBeNull();
    expect(findApplicationShortcutConflict("settings", "Ctrl+Shift+Equal", bindings, false)).toBe(
      "zoomIn"
    );
    expect(findApplicationShortcutConflict("settings", "", bindings, false)).toBeNull();
    expect(
      findApplicationShortcutConflict("settings", "Ctrl+Z", { ...bindings, undo: "" }, false)
    ).toBeNull();
    expect(findApplicationShortcutConflict("settings", "Ctrl+Alt+K", bindings, false)).toBeNull();
  });

  test("invalid and incomplete recordings never become usable accelerators", () => {
    for (const value of [
      "Ctrl",
      "Ctrl+",
      "Ctrl+++",
      "Ctrl+Alt+",
      "Hyper+K",
      "Ctrl+Unknown",
      "Ctrl+A+B",
    ]) {
      expect(normalizeApplicationShortcut(value, false)).toBeNull();
      expect(
        applicationShortcutMatches(key("z", { ctrlKey: true }), "undo", { undo: value }, false)
      ).toBe(false);
    }
    expect(normalizeApplicationShortcut("", false)).toBe("");
    expect(normalizeApplicationShortcut("   ", false)).toBe("");
    expect(normalizeApplicationShortcut("F11", false)).toBe("F11");
    expect(applicationShortcutMatches(key("F11"), "fullscreen", undefined, false)).toBe(true);
    expect(
      applicationShortcutMatches(key("F11", { shiftKey: true }), "fullscreen", undefined, false)
    ).toBe(false);
  });

  test("labels preserve disabled bindings and use platform navigation names", () => {
    expect(formatApplicationShortcutLabel("", false)).toBe("");
    expect(formatApplicationShortcutLabel("Alt+ArrowLeft", true)).toBe("Option+←");
    expect(formatApplicationShortcutLabel("Alt+ArrowRight", false)).toBe("Alt+→");
    expect(formatApplicationShortcutLabel("Ctrl+Plus", false)).toBe("Ctrl++");
    expect(normalizeApplicationShortcut("Control+Backslash", false)).toBe("Ctrl+\\");
    expect(
      applicationShortcutMatches(
        key(" ", { ctrlKey: true }),
        "settings",
        { settings: "Ctrl+Space" },
        false
      )
    ).toBe(true);
  });
});

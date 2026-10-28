import type { HotkeyConfig } from "@/components/HotkeyConfig";

type ShortcutEvent = Pick<
  KeyboardEvent,
  | "key"
  | "code"
  | "ctrlKey"
  | "metaKey"
  | "altKey"
  | "shiftKey"
  | "defaultPrevented"
  | "repeat"
  | "isComposing"
>;

export function settingsShortcutMatches(event: ShortcutEvent, mac: boolean): boolean {
  const primary = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return (
    primary && !event.altKey && !event.shiftKey && (event.key === "," || event.code === "Comma")
  );
}

export function hasCustomSettingsShortcut(
  bindings: readonly HotkeyConfig[],
  mac: boolean
): boolean {
  return bindings.some((binding) => {
    if (!binding || binding.enabled === false || typeof binding.value !== "string") return false;
    const parts = binding.value.replace(/\s+/g, "").toLowerCase().split("+");
    const key = parts.pop();
    if (key !== "," && key !== "comma") return false;
    if (
      parts.some(
        (part) =>
          ![
            "ctrl",
            "control",
            "cmd",
            "command",
            "meta",
            "super",
            "win",
            "commandorcontrol",
            "cmdorctrl",
            "alt",
            "option",
            "opt",
            "shift",
          ].includes(part)
      )
    )
      return false;
    const modifiers = new Set(parts);
    const primary = modifiers.has("commandorcontrol") || modifiers.has("cmdorctrl");
    return settingsShortcutMatches(
      {
        key: ",",
        code: "Comma",
        ctrlKey: modifiers.has("ctrl") || modifiers.has("control") || (primary && !mac),
        metaKey:
          ["cmd", "command", "meta", "super", "win"].some((name) => modifiers.has(name)) ||
          (primary && mac),
        altKey: ["alt", "option", "opt"].some((name) => modifiers.has(name)),
        shiftKey: modifiers.has("shift"),
        defaultPrevented: false,
        repeat: false,
        isComposing: false,
      },
      mac
    );
  });
}

/** Menus own this application shortcut only after setup and outside modal/recording flows. */
export function shouldOpenSettingsFromShortcut(
  event: ShortcutEvent,
  context: { mac: boolean; ready: boolean; blocked: boolean; bindings: readonly HotkeyConfig[] }
): boolean {
  return (
    context.ready &&
    !context.blocked &&
    !event.defaultPrevented &&
    !event.repeat &&
    !event.isComposing &&
    settingsShortcutMatches(event, context.mac) &&
    !hasCustomSettingsShortcut(context.bindings, context.mac)
  );
}

export function titlebarShortcutLabels(mac: boolean) {
  const primary = mac ? "Cmd" : "Ctrl";
  const alt = mac ? "Option" : "Alt";
  return {
    undo: `${primary}+Z`,
    redo: mac ? "Cmd+Shift+Z" : "Ctrl+Y",
    cut: `${primary}+X`,
    copy: `${primary}+C`,
    paste: `${primary}+V`,
    delete: mac ? "Fn+Delete" : "Delete",
    selectAll: `${primary}+A`,
    settings: `${primary}+,`,
    sidebar: `${primary}+Shift+S`,
    back: `${alt}+←`,
    forward: `${alt}+→`,
    zoomIn: `${primary}++`,
    zoomOut: `${primary}+-`,
    resetZoom: `${primary}+0`,
  };
}

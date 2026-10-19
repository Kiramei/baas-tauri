import type { TranslationKey } from "@/types/i18n";
import { i18nKey } from "./I18nKeys";

export type ApplicationShortcutId =
  | "undo"
  | "redo"
  | "settings"
  | "sidebar"
  | "back"
  | "forward"
  | "zoomIn"
  | "zoomOut"
  | "resetZoom"
  | "fullscreen";

export type ApplicationShortcutBindings = Record<ApplicationShortcutId, string>;
export type ApplicationShortcutOverrides = Partial<ApplicationShortcutBindings>;

export const APPLICATION_SHORTCUTS: readonly {
  id: ApplicationShortcutId;
  label: TranslationKey;
  description: TranslationKey;
}[] = [
  { id: "undo", label: i18nKey("edit.undo"), description: i18nKey("applicationShortcutHelp.undo") },
  { id: "redo", label: i18nKey("edit.redo"), description: i18nKey("applicationShortcutHelp.redo") },
  {
    id: "settings",
    label: i18nKey("nav.settings"),
    description: i18nKey("applicationShortcutHelp.settings"),
  },
  {
    id: "sidebar",
    label: i18nKey("view.sidebar"),
    description: i18nKey("applicationShortcutHelp.sidebar"),
  },
  { id: "back", label: i18nKey("app.back"), description: i18nKey("applicationShortcutHelp.back") },
  {
    id: "forward",
    label: i18nKey("app.forward"),
    description: i18nKey("applicationShortcutHelp.forward"),
  },
  {
    id: "zoomIn",
    label: i18nKey("view.zoomIn"),
    description: i18nKey("applicationShortcutHelp.zoomIn"),
  },
  {
    id: "zoomOut",
    label: i18nKey("view.zoomOut"),
    description: i18nKey("applicationShortcutHelp.zoomOut"),
  },
  {
    id: "resetZoom",
    label: i18nKey("view.resetZoom"),
    description: i18nKey("applicationShortcutHelp.resetZoom"),
  },
  {
    id: "fullscreen",
    label: i18nKey("view.fullscreen"),
    description: i18nKey("applicationShortcutHelp.fullscreen"),
  },
];

export function applicationShortcutPlatformIsMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "");
}

export function shortcutDefaults(mac: boolean): ApplicationShortcutBindings {
  const primary = mac ? "Cmd" : "Ctrl";
  return {
    undo: primary + "+Z",
    redo: mac ? "Cmd+Shift+Z" : "Ctrl+Y",
    settings: primary + "+,",
    sidebar: primary + "+Shift+S",
    back: "Alt+ArrowLeft",
    forward: "Alt+ArrowRight",
    zoomIn: primary + "++",
    zoomOut: primary + "+-",
    resetZoom: primary + "+0",
    fullscreen: "F11",
  };
}

const aliases: Record<string, string> = {
  plus: "+",
  add: "+",
  numpadadd: "+",
  equal: "+",
  equals: "+",
  "=": "+",
  minus: "-",
  subtract: "-",
  numpadsubtract: "-",
  comma: ",",
  period: ".",
  slash: "/",
  backslash: "\\",
  semicolon: ";",
  quote: "'",
  backquote: "`",
  bracketleft: "[",
  bracketright: "]",
  esc: "Escape",
  escape: "Escape",
  return: "Enter",
  enter: "Enter",
  space: "Space",
  " ": "Space",
  spacebar: "Space",
  tab: "Tab",
  left: "ArrowLeft",
  arrowleft: "ArrowLeft",
  "←": "ArrowLeft",
  right: "ArrowRight",
  arrowright: "ArrowRight",
  "→": "ArrowRight",
  up: "ArrowUp",
  arrowup: "ArrowUp",
  "↑": "ArrowUp",
  down: "ArrowDown",
  arrowdown: "ArrowDown",
  "↓": "ArrowDown",
  del: "Delete",
  delete: "Delete",
  backspace: "Backspace",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
};

function normalizeKey(key: string): string | null {
  const lower = key.toLowerCase();
  if (aliases[lower]) return aliases[lower];
  if (/^key[a-z]$/i.test(key)) return key.slice(3).toUpperCase();
  if (/^(digit|numpad)[0-9]$/i.test(key)) return key.slice(-1);
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(key)) return key.toUpperCase();
  if (/^[a-z0-9]$/i.test(key)) return key.toUpperCase();
  return key.length === 1 && /[+\-.,/\\;'[\]`~!@#$%^&*()_{}|:"<>?]/.test(key) ? key : null;
}

function formatParts(
  key: string,
  flags: { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean },
  mac: boolean
): string {
  const parts: string[] = [];
  if (mac && flags.meta) parts.push("Cmd");
  if (flags.ctrl) parts.push("Ctrl");
  if (flags.alt) parts.push("Alt");
  // The Shift that produces + on Equal is part of the key itself.
  if (flags.shift && key !== "+") parts.push("Shift");
  if (!mac && flags.meta) parts.push("Meta");
  parts.push(key);
  return parts.join("+");
}

/** Canonical accelerator syntax shared by recording, conflicts, labels, and matching. */
export function normalizeApplicationShortcut(
  value: string,
  mac = applicationShortcutPlatformIsMac()
): string | null {
  const raw = value.trim().replace(/\s+/g, "");
  if (!raw) return "";
  let key: string;
  let modifiers: string[];
  if (raw === "+") {
    key = "+";
    modifiers = [];
  } else if (raw.endsWith("++")) {
    key = "+";
    const prefix = raw.slice(0, -2);
    modifiers = prefix ? prefix.split("+") : [];
  } else {
    const parts = raw.split("+");
    key = parts.pop() ?? "";
    modifiers = parts;
  }
  const normalized = normalizeKey(key);
  if (!normalized) return null;
  const flags = { ctrl: false, alt: false, shift: false, meta: false };
  for (const modifier of modifiers) {
    switch (modifier.toLowerCase()) {
      case "ctrl":
      case "control":
        flags.ctrl = true;
        break;
      case "alt":
      case "option":
      case "opt":
        flags.alt = true;
        break;
      case "shift":
        flags.shift = true;
        break;
      case "cmd":
      case "command":
      case "meta":
      case "super":
      case "win":
        flags.meta = true;
        break;
      case "commandorcontrol":
      case "commandorctrl":
      case "cmdorctrl":
        if (mac) flags.meta = true;
        else flags.ctrl = true;
        break;
      default:
        return null;
    }
  }
  return formatParts(normalized, flags, mac);
}

export function resolveApplicationShortcutBindings(
  overrides: ApplicationShortcutOverrides | null | undefined,
  mac = applicationShortcutPlatformIsMac()
): ApplicationShortcutBindings {
  const bindings = shortcutDefaults(mac);
  for (const { id } of APPLICATION_SHORTCUTS) {
    const value = overrides?.[id];
    if (typeof value !== "string") continue;
    const normalized = normalizeApplicationShortcut(value, mac);
    if (normalized !== null) bindings[id] = normalized;
  }
  return bindings;
}

export type ApplicationShortcutEvent = Pick<
  KeyboardEvent,
  "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"
>;

/** Keyboard codes keep recorder output stable for shifted punctuation and non-Latin layouts. */
export function applicationShortcutFromEvent(
  event: ApplicationShortcutEvent,
  mac = applicationShortcutPlatformIsMac()
): string | null {
  const code = event.code || "";
  const codeKey = normalizeKey(code);
  const key = codeKey ?? normalizeKey(event.key);
  if (!key) return null;
  return formatParts(
    key,
    {
      ctrl: event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
      meta: event.metaKey,
    },
    mac
  );
}

export function applicationShortcutMatches(
  event: ApplicationShortcutEvent,
  id: ApplicationShortcutId,
  bindings?: ApplicationShortcutOverrides | null,
  mac = applicationShortcutPlatformIsMac()
): boolean {
  const value = bindings?.[id] ?? shortcutDefaults(mac)[id];
  if (typeof value !== "string" || !value.trim()) return false;
  const expected = normalizeApplicationShortcut(value, mac);
  return expected !== null && expected === applicationShortcutFromEvent(event, mac);
}

/** Empty bindings never conflict; aliases such as Ctrl+Shift+= and Ctrl++ share one slot. */
export function findApplicationShortcutConflict(
  id: ApplicationShortcutId,
  value: string,
  bindings: ApplicationShortcutBindings,
  mac = applicationShortcutPlatformIsMac()
): ApplicationShortcutId | null {
  const normalized = normalizeApplicationShortcut(value, mac);
  if (!normalized) return null;
  return (
    APPLICATION_SHORTCUTS.find(
      (entry) =>
        entry.id !== id && normalizeApplicationShortcut(bindings[entry.id], mac) === normalized
    )?.id ?? null
  );
}

export function formatApplicationShortcutLabel(
  value: string,
  mac = applicationShortcutPlatformIsMac()
): string {
  const normalized = normalizeApplicationShortcut(value, mac);
  return (normalized ?? value)
    .replace(/ArrowLeft/g, "←")
    .replace(/ArrowRight/g, "→")
    .replace(/ArrowUp/g, "↑")
    .replace(/ArrowDown/g, "↓")
    .replace(/\bAlt\b/g, mac ? "Option" : "Alt");
}

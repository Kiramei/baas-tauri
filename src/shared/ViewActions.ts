import type { HotkeyConfig } from "@/components/HotkeyConfig";

export const MIN_WORKSPACE_ZOOM = 50;
export const MAX_WORKSPACE_ZOOM = 150;

/** One policy for the View menu and its keyboard action. Settings keeps its sidebar open. */
export function canToggleWorkspaceSidebar(
  available: boolean,
  desktop: boolean,
  sidebarLocked: boolean
): boolean {
  return available && desktop && !sidebarLocked;
}

export function normalizeWorkspaceZoom(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(MAX_WORKSPACE_ZOOM, Math.max(MIN_WORKSPACE_ZOOM, value))
    : 100;
}

/** Use the same ten-percent scale choices as Settings, including custom intermediate values. */
export function stepWorkspaceZoom(value: unknown, direction: -1 | 1): number {
  const current = normalizeWorkspaceZoom(value);
  return normalizeWorkspaceZoom(
    direction > 0 ? Math.floor(current / 10 + 1) * 10 : Math.ceil(current / 10 - 1) * 10
  );
}

export type ViewShortcutAction = "sidebar" | "zoomIn" | "zoomOut" | "resetZoom" | "fullscreen";
type ShortcutEvent = Pick<
  KeyboardEvent,
  "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"
>;

/** Alt navigation remains owned by NavigationHistoryProvider. */
export function viewShortcutFromEvent(
  event: ShortcutEvent,
  mac: boolean
): ViewShortcutAction | null {
  const primary = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (event.key === "F11" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey)
    return "fullscreen";
  if (!primary || event.altKey) return null;
  if (event.key === "+" || event.key === "=" || event.code === "NumpadAdd") return "zoomIn";
  if (event.key.toLowerCase() === "s" && event.shiftKey) return "sidebar";
  if (event.shiftKey) return null;
  if (event.key === "-" || event.code === "NumpadSubtract") return "zoomOut";
  if (event.key === "0" || event.code === "Numpad0") return "resetZoom";
  return null;
}

/** Compare the action family so a saved Ctrl+Shift+= also reserves Ctrl+Plus for the user. */
export function hasCustomViewShortcut(
  action: ViewShortcutAction,
  bindings: readonly HotkeyConfig[],
  mac: boolean
): boolean {
  return bindings.some((binding) => {
    if (
      !binding ||
      binding.enabled === false ||
      typeof binding.value !== "string" ||
      !binding.value.trim()
    )
      return false;
    const raw = binding.value.replace(/\s+/g, "");
    const parts = raw
      .split("+")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean);
    let key = raw.endsWith("++") ? "+" : parts.pop() || "";
    const modifiers = new Set(parts);
    const primary = modifiers.has("commandorcontrol") || modifiers.has("cmdorctrl");
    const ctrlKey = modifiers.has("ctrl") || modifiers.has("control") || (primary && !mac);
    const metaKey =
      ["cmd", "command", "meta", "super", "win"].some((name) => modifiers.has(name)) ||
      (primary && mac);
    const altKey = modifiers.has("alt") || modifiers.has("option") || modifiers.has("opt");
    const shiftKey = modifiers.has("shift");
    const aliases: Record<string, string> = { plus: "+", equal: "=", minus: "-", digit0: "0" };
    key = aliases[key] || key;
    return (
      viewShortcutFromEvent(
        { key: key === "f11" ? "F11" : key, code: "", ctrlKey, metaKey, altKey, shiftKey },
        mac
      ) === action
    );
  });
}

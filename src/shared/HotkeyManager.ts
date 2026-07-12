/**
 * Helpers for normalizing and validating keyboard shortcut combinations.
 */
import type { TFunction } from "i18next";
import type { HotkeyConfig } from "@/components/HotkeyConfig";
import type { ConfigProfileSummary } from "@/types/app";

/** Returns the get default hotkeys result. */
export function getDefaultHotkeys(t: TFunction): HotkeyConfig[] {
  return [
    { id: "toggle-run", label: t("hotkey.switch.start"), value: "" },
    { id: "clear-logs", label: t("hotkey.clear.logs"), value: "" },
    { id: "help", label: t("hotkey.help.about"), value: "" },
  ];
}

/** Handles the profile toggle hotkey id workflow. */
export const profileToggleHotkeyId = (configId: string) => `toggle-run:${configId}`;

/** Handles the default profile accelerator workflow. */
export function defaultProfileAccelerator(index: number): string {
  if (index >= 0 && index < 9) return `Ctrl+Alt+Shift+${index + 1}`;
  if (index === 9) return "Ctrl+Alt+Shift+0";
  if (index >= 10 && index < 22) return `Ctrl+Alt+Shift+F${index - 9}`;
  return "";
}

/** Handles the reconcile profile hotkeys workflow. */
export function reconcileProfileHotkeys(
  profiles: ConfigProfileSummary[],
  stored: HotkeyConfig[] | null | undefined,
  toggleLabel = "Start/Stop"
): HotkeyConfig[] {
  const storedByConfigId = new Map<string, HotkeyConfig>();

  for (const hotkey of stored ?? []) {
    const configId = hotkey.configId ?? configIdFromHotkeyId(hotkey.id);
    if (!configId) continue;
    storedByConfigId.set(configId, hotkey);
  }

  return profiles.map((profile, index) => {
    const existing = storedByConfigId.get(profile.id);
    return {
      id: profileToggleHotkeyId(profile.id),
      configId: profile.id,
      label: `${toggleLabel} - ${profile.name}`,
      value: existing?.value ?? defaultProfileAccelerator(index),
      enabled: existing?.enabled ?? true,
    };
  });
}

/** Handles the config id from hotkey id workflow. */
function configIdFromHotkeyId(id: string): string | null {
  const prefix = "toggle-run:";
  return id.startsWith(prefix) ? id.slice(prefix.length) : null;
}

/** Returns the normalize combo result. */
export function normalizeCombo(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, "");
}

/** Handles the event to combo workflow. */
export function eventToCombo(e: KeyboardEvent): string {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("ctrl");
  if (e.shiftKey) mods.push("shift");
  if (e.altKey) mods.push("alt");
  if (e.metaKey) mods.push("meta");
  const main = e.key.length === 1 ? e.key.toUpperCase() : e.key.toUpperCase();
  return normalizeCombo([...mods, main].join("+"));
}

/**
 * Helpers for normalizing and validating keyboard shortcut combinations.
 */
import type { TFunction } from "i18next";
import type { HotkeyConfig } from "@/components/HotkeyConfig";
import type { ConfigProfile } from "@/types/app";

export function getDefaultHotkeys(t: TFunction): HotkeyConfig[] {
  return [
    { id: "toggle-run", label: t("hotkey.switch.start"), value: "" },
    { id: "clear-logs", label: t("hotkey.clear.logs"), value: "" },
    { id: "help", label: t("hotkey.help.about"), value: "" },
  ];
}

export const profileToggleHotkeyId = (configId: string) => `toggle-run:${configId}`;

export function defaultProfileAccelerator(index: number): string {
  if (index >= 0 && index < 9) return `Ctrl+Alt+Shift+${index + 1}`;
  if (index === 9) return "Ctrl+Alt+Shift+0";
  if (index >= 10 && index < 22) return `Ctrl+Alt+Shift+F${index - 9}`;
  return "";
}

export function reconcileProfileHotkeys(
  profiles: ConfigProfile[],
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

function configIdFromHotkeyId(id: string): string | null {
  const prefix = "toggle-run:";
  return id.startsWith(prefix) ? id.slice(prefix.length) : null;
}

export function normalizeCombo(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, "");
}

export function eventToCombo(e: KeyboardEvent): string {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("ctrl");
  if (e.shiftKey) mods.push("shift");
  if (e.altKey) mods.push("alt");
  if (e.metaKey) mods.push("meta");
  const main = e.key.length === 1 ? e.key.toUpperCase() : e.key.toUpperCase();
  return normalizeCombo([...mods, main].join("+"));
}

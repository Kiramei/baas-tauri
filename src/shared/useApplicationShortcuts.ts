import { useCallback, useMemo } from "react";
import { useSetUISettings, useUISetting } from "@/context/UISettingsProvider";
import {
  applicationShortcutPlatformIsMac,
  findApplicationShortcutConflict,
  formatApplicationShortcutLabel,
  normalizeApplicationShortcut,
  resolveApplicationShortcutBindings,
  shortcutDefaults,
  type ApplicationShortcutId,
} from "./ApplicationShortcuts";

/** Window-local application accelerators; no script patches or OS-global registrations. */
export function useApplicationShortcuts() {
  const overrides = useUISetting((settings) => settings.applicationShortcuts);
  const setUiSettings = useSetUISettings();
  const mac = applicationShortcutPlatformIsMac();
  const defaults = useMemo(() => shortcutDefaults(mac), [mac]);
  const bindings = useMemo(
    () => resolveApplicationShortcutBindings(overrides, mac),
    [overrides, mac]
  );
  const bindingConflict = useCallback(
    (id: ApplicationShortcutId, value: string) =>
      findApplicationShortcutConflict(id, value, bindings, mac),
    [bindings, mac]
  );
  const setBinding = useCallback(
    (id: ApplicationShortcutId, value: string): boolean => {
      const normalized = normalizeApplicationShortcut(value, mac);
      if (normalized === null) return false;
      let accepted = false;
      setUiSettings((settings) => {
        const current = resolveApplicationShortcutBindings(settings.applicationShortcuts, mac);
        if (findApplicationShortcutConflict(id, normalized, current, mac)) return settings;
        accepted = true;
        if (current[id] === normalized) return settings;
        const next = { ...settings.applicationShortcuts };
        if (normalized === defaults[id]) delete next[id];
        else next[id] = normalized;
        return { ...settings, applicationShortcuts: next };
      });
      return accepted;
    },
    [defaults, mac, setUiSettings]
  );
  const resetAll = useCallback(() => {
    setUiSettings((settings) => ({ ...settings, applicationShortcuts: {} }));
  }, [setUiSettings]);
  const shortcutLabel = useCallback(
    (id: ApplicationShortcutId) => formatApplicationShortcutLabel(bindings[id], mac),
    [bindings, mac]
  );
  return { bindings, defaults, setBinding, resetAll, bindingConflict, shortcutLabel };
}

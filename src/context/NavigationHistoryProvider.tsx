import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { NavigationHistory } from "@/shared/NavigationHistory";
import { useApplicationShortcuts } from "@/shared/useApplicationShortcuts";
import {
  applicationShortcutMatches,
  normalizeApplicationShortcut,
} from "@/shared/ApplicationShortcuts";
import StorageUtil from "@/shared/StorageManager";
import type { HotkeyConfig } from "@/components/HotkeyConfig";

const NavigationHistoryContext = createContext<NavigationHistory | undefined>(undefined);

export function NavigationHistoryProvider({ children }: { children: ReactNode }) {
  const [history] = useState(() => new NavigationHistory());
  const applicationShortcuts = useApplicationShortcuts();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (
        event.target instanceof Element &&
        event.target.closest(
          "input, textarea, select, [contenteditable='true'], [role='dialog'], [role='alertdialog']"
        )
      )
        return;
      // Dialogs block navigation even when focus has not moved into them yet.
      if (document.querySelector("[aria-modal='true']")) return;
      if (!history.getSnapshot().available) return;
      const mac = /Mac|iPhone|iPad/.test(navigator.platform || "");
      const action = (["back", "forward"] as const).find((id) =>
        applicationShortcutMatches(event, id, applicationShortcuts.bindings, mac)
      );
      if (!action) return;
      let profiles: HotkeyConfig[] = [];
      try {
        const saved = StorageUtil.get<HotkeyConfig[]>("hotkeys");
        profiles = Array.isArray(saved) ? saved : [];
      } catch {
        /* Setup has no bindings yet. */
      }
      if (
        profiles.some(
          (binding) =>
            binding.enabled !== false &&
            binding.value &&
            normalizeApplicationShortcut(binding.value, mac) ===
              normalizeApplicationShortcut(applicationShortcuts.bindings[action], mac)
        )
      )
        return;
      // At a boundary this remains an application no-op, rather than letting
      // the embedded browser navigate away from its application URL.
      event.preventDefault();
      if (action === "back") history.back();
      else history.forward();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [applicationShortcuts.bindings, history]);

  return (
    <NavigationHistoryContext.Provider value={history}>
      {children}
    </NavigationHistoryContext.Provider>
  );
}

export function useNavigationHistoryController(): NavigationHistory {
  const history = useContext(NavigationHistoryContext);
  if (!history) throw new Error("Navigation history requires a NavigationHistoryProvider");
  return history;
}

export function useNavigationHistory() {
  const history = useNavigationHistoryController();
  const state = useSyncExternalStore(history.subscribe, history.getSnapshot, history.getSnapshot);
  return {
    ...state,
    back: history.back,
    forward: history.forward,
    openSettings: history.openSettings,
  };
}

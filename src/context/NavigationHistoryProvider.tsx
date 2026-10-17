import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { NavigationHistory } from "@/shared/NavigationHistory";

const NavigationHistoryContext = createContext<NavigationHistory | undefined>(undefined);

export function NavigationHistoryProvider({ children }: { children: ReactNode }) {
  const [history] = useState(() => new NavigationHistory());

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        !event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
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
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      // At a boundary this remains an application no-op, rather than letting
      // the embedded browser navigate away from its application URL.
      event.preventDefault();
      if (event.key === "ArrowLeft") history.back();
      else history.forward();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [history]);

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
  return { ...state, back: history.back, forward: history.forward };
}

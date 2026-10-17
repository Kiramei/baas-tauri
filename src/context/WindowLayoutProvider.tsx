import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import StorageUtil from "@/shared/StorageManager";

interface WindowLayoutContextType {
  expanded: boolean;
  available: boolean;
  customFrame: boolean;
  registerSidebar: () => () => void;
  setExpanded: (expanded: boolean) => void;
  setCustomFrame: (customFrame: boolean) => void;
}

const WindowLayoutContext = createContext<WindowLayoutContextType | undefined>(undefined);

export function WindowLayoutProvider({ children }: { children: ReactNode }) {
  const [expanded, setExpandedState] = useState(true);
  const [available, setAvailable] = useState(false);
  const [customFrame, setCustomFrame] = useState(false);

  const registerSidebar = useCallback(() => {
    // The workspace mounts after storage is initialized. Setup never registers
    // a sidebar and therefore shows no inactive control.
    const stored = StorageUtil.get<boolean>("desktopSidebarExpanded");
    setExpandedState(typeof stored === "boolean" ? stored : true);
    setAvailable(true);
    return () => setAvailable(false);
  }, []);

  const setExpanded = useCallback((next: boolean) => {
    setExpandedState(next);
    StorageUtil.set("desktopSidebarExpanded", next);
  }, []);

  const value = useMemo(
    () => ({ expanded, available, customFrame, registerSidebar, setExpanded, setCustomFrame }),
    [expanded, available, customFrame, registerSidebar, setExpanded]
  );

  return <WindowLayoutContext.Provider value={value}>{children}</WindowLayoutContext.Provider>;
}

/** Shared layouts also mount beneath the separate Android application entry. */
export function WindowLayoutBoundary({ children }: { children: ReactNode }) {
  const context = useContext(WindowLayoutContext);
  return context ? <>{children}</> : <WindowLayoutProvider>{children}</WindowLayoutProvider>;
}

export function useWindowLayout(): WindowLayoutContextType {
  const context = useContext(WindowLayoutContext);
  if (!context) throw new Error("useWindowLayout must be used within a WindowLayoutProvider");
  return context;
}

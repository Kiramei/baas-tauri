import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import StorageUtil from "@/shared/StorageManager";

interface WindowLayoutContextType {
  expanded: boolean;
  available: boolean;
  sidebarLocked: boolean;
  customFrame: boolean;
  fullscreen: boolean;
  registerSidebar: () => () => void;
  setExpanded: (expanded: boolean) => void;
  setSidebarLocked: (locked: boolean) => void;
  setCustomFrame: (customFrame: boolean) => void;
  setFullscreen: (fullscreen: boolean) => void;
}

const WindowLayoutContext = createContext<WindowLayoutContextType | undefined>(undefined);

export function WindowLayoutProvider({ children }: { children: ReactNode }) {
  // Locking Settings open must not overwrite the user's other-page preference.
  const [preferredExpanded, setExpandedState] = useState(true);
  const [available, setAvailable] = useState(false);
  const [sidebarLocked, setSidebarLockedState] = useState(false);
  const sidebarLockedRef = useRef(false);
  const [customFrame, setCustomFrame] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  const registerSidebar = useCallback(() => {
    // The workspace mounts after storage is initialized. Setup never registers
    // a sidebar and therefore shows no inactive control.
    const stored = StorageUtil.get<boolean>("desktopSidebarExpanded");
    setExpandedState(typeof stored === "boolean" ? stored : true);
    setAvailable(true);
    return () => setAvailable(false);
  }, []);

  const setExpanded = useCallback((next: boolean) => {
    if (sidebarLockedRef.current) return;
    setExpandedState(next);
    StorageUtil.set("desktopSidebarExpanded", next);
  }, []);

  const setSidebarLocked = useCallback((locked: boolean) => {
    sidebarLockedRef.current = locked;
    setSidebarLockedState(locked);
  }, []);
  const expanded = sidebarLocked || preferredExpanded;

  const value = useMemo(
    () => ({
      expanded,
      available,
      sidebarLocked,
      customFrame,
      fullscreen,
      registerSidebar,
      setExpanded,
      setSidebarLocked,
      setCustomFrame,
      setFullscreen,
    }),
    [
      expanded,
      available,
      sidebarLocked,
      customFrame,
      fullscreen,
      registerSidebar,
      setExpanded,
      setSidebarLocked,
    ]
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

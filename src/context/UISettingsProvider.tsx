import React, {
  createContext,
  ReactNode,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import type { UISettings } from "@/types/app";
import StorageUtil from "@/shared/StorageManager.ts";

interface UISettingsContextType {
  uiSettings: UISettings;
  setUiSettings: React.Dispatch<React.SetStateAction<UISettings>>;
}

interface UISettingsStore {
  getSnapshot: () => UISettings;
  subscribe: (listener: () => void) => () => void;
  set: React.Dispatch<React.SetStateAction<UISettings>>;
  attach: () => void;
  detach: () => void;
}

const DEFAULT_UI_SETTINGS: UISettings = {
  lang: "",
  theme: "",
  themeColor: "#0891b2",
  backgroundImageBase64: null,
  backgroundImageOpacity: 0.18,
  zoomScale: 100,
  scrollToEnd: true,
  assetsDisplay: true,
  enableBAComet: false,
  lowPerformanceMode: false,
  enableSystemNotifications: true,
  remoteSettings: {
    streamPlayer: "mse",
    enableSafeStream: true,
    maxWidth: 1280,
    maxHeight: 720,
    maxFPS: 60,
    iFrameRate: 10,
    bitRate: 7340032,
    showStatus: false,
  },
};

const loadInitialSettings = (): UISettings => {
  const stored = StorageUtil.get("uiSettings") as UISettings | null;
  if (!stored) {
    StorageUtil.set("uiSettings", DEFAULT_UI_SETTINGS);
    return DEFAULT_UI_SETTINGS;
  }
  return {
    ...DEFAULT_UI_SETTINGS,
    ...stored,
    remoteSettings: {
      ...DEFAULT_UI_SETTINGS.remoteSettings,
      ...stored.remoteSettings,
    },
  };
};

const createUISettingsStore = (): UISettingsStore => {
  let settings = loadInitialSettings();
  const listeners = new Set<() => void>();
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (persistTimer !== null) clearTimeout(persistTimer);
    persistTimer = null;
    StorageUtil.set("uiSettings", settings);
  };
  const schedulePersist = () => {
    if (persistTimer !== null) return;
    persistTimer = setTimeout(flush, 150);
  };
  return {
    getSnapshot: () => settings,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (update) => {
      const next = typeof update === "function" ? update(settings) : update;
      if (Object.is(next, settings)) return;
      settings = next;
      schedulePersist();
      listeners.forEach((listener) => listener());
    },
    attach: () => window.addEventListener("pagehide", flush),
    detach: () => {
      window.removeEventListener("pagehide", flush);
      flush();
    },
  };
};

const UISettingsStoreContext = createContext<UISettingsStore | undefined>(undefined);

const useUISettingsStore = () => {
  const store = useContext(UISettingsStoreContext);
  if (!store) throw new Error("useUISettings must be used within a UISettingsProvider");
  return store;
};

/** Provides a stable store so settings updates only render subscribed consumers. */
export const UISettingsProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [store] = useState(createUISettingsStore);
  React.useEffect(() => {
    store.attach();
    return () => store.detach();
  }, [store]);

  return (
    <UISettingsStoreContext.Provider value={store}>{children}</UISettingsStoreContext.Provider>
  );
};

/** Subscribes to the complete settings object for editor surfaces. */
export const useUISettings = (): UISettingsContextType => {
  const store = useUISettingsStore();
  const uiSettings = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return useMemo(() => ({ uiSettings, setUiSettings: store.set }), [store.set, uiSettings]);
};

/** Subscribes a component to the smallest settings slice it renders. */
export const useUISetting = <T,>(selector: (settings: UISettings) => T): T => {
  const store = useUISettingsStore();
  const getSelectedSnapshot = () => selector(store.getSnapshot());
  return useSyncExternalStore(store.subscribe, getSelectedSnapshot, getSelectedSnapshot);
};

/** Returns the stable settings dispatcher without subscribing to settings changes. */
export const useSetUISettings = () => useUISettingsStore().set;

export { DEFAULT_UI_SETTINGS };

import React, { createContext, ReactNode, useContext, useEffect, useState } from "react";

import type { UISettings } from "@/types/app";
import StorageUtil from "@/shared/StorageManager.ts";

interface UISettingsContextType {
  uiSettings: UISettings;
  setUiSettings: React.Dispatch<React.SetStateAction<UISettings>>;
}

const DEFAULT_UI_SETTINGS: UISettings = {
  lang: "",
  theme: "",
  zoomScale: 100,
  scrollToEnd: true,
  assetsDisplay: true,
  enableBAComet: false,
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

const UISettingsContext = createContext<UISettingsContextType | undefined>(undefined);

export const UISettingsProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [initialized, setInitialized] = useState(false);
  const [uiSettings, setUiSettings] = useState<UISettings>(DEFAULT_UI_SETTINGS);

  useEffect(() => {
    const storedSettings = StorageUtil.get("uiSettings") as UISettings | null;

    if (!storedSettings) {
      setUiSettings(DEFAULT_UI_SETTINGS);
      StorageUtil.set("uiSettings", DEFAULT_UI_SETTINGS);
    } else {
      setUiSettings({
        ...DEFAULT_UI_SETTINGS,
        ...storedSettings,
      });
    }

    setInitialized(true);
  }, []);

  useEffect(() => {
    if (!initialized) return;
    StorageUtil.set("uiSettings", uiSettings);
  }, [initialized, uiSettings]);

  return (
    <UISettingsContext.Provider value={{ uiSettings, setUiSettings }}>
      {children}
    </UISettingsContext.Provider>
  );
};

export const useUISettings = (): UISettingsContextType => {
  const context = useContext(UISettingsContext);

  if (context === undefined) {
    throw new Error("useUISettings must be used within a UISettingsProvider");
  }

  return context;
};

export { DEFAULT_UI_SETTINGS };

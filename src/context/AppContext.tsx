import React, { createContext, ReactNode, useContext, useEffect, useState } from "react";
import type { ConfigProfile, UISettings } from "@/types/app";
import { GlobalSelectProvider } from "@/components/ui/SelectGlobal";
import { resolveHttpBase, useBackendStore } from "@/store/BackendStore";

import StorageUtil from "@/shared/StorageManager.ts";
import { DEFAULT_UI_SETTINGS } from "@/context/UISettingsProvider";

interface AppContextType {
  uiSettings: UISettings;
  setUiSettings: React.Dispatch<React.SetStateAction<UISettings>>;
  profiles: ConfigProfile[];
  activeProfile: ConfigProfile | null;
  setActiveProfile: (profile: ConfigProfile | null) => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

/** Renders the app provider component. */
export const AppProvider: React.FC<{ children: ReactNode; setReady: (value: boolean) => void }> = ({
  children,
  setReady,
}) => {
  const [profiles, setProfiles] = useState<ConfigProfile[]>([]);
  const [activeProfile, setActiveProfile] = useState<ConfigProfile | null>(null);
  const [stageInitiated, setStageInitiated] = useState<boolean>(false);
  const [uiSettings, setUiSettings] = useState<UISettings>(DEFAULT_UI_SETTINGS);
  const init = useBackendStore((s) => s.init);
  const authPhase = useBackendStore((s) => s._auth_phase);
  const allDataInitialized = useBackendStore((s) => s._all_data_initialized);
  const initiating = useBackendStore((s) => s._initiating);
  const configStore = useBackendStore((s) => s.configStore);

  useEffect(() => {
    if (authPhase === "authenticated" && !allDataInitialized) {
      void init();
    }
  }, [authPhase, allDataInitialized, init]);

  useEffect(() => {
    const _uiSettings: UISettings | null = StorageUtil.get("uiSettings");
    if (!_uiSettings) {
      setUiSettings(DEFAULT_UI_SETTINGS);
      StorageUtil.set("uiSettings", DEFAULT_UI_SETTINGS);
    } else {
      setUiSettings({
        ...DEFAULT_UI_SETTINGS,
        ..._uiSettings,
        remoteSettings: {
          ...DEFAULT_UI_SETTINGS.remoteSettings,
          ..._uiSettings.remoteSettings,
        },
      });
    }
    setStageInitiated(true);
  }, []);

  useEffect(() => {
    if (stageInitiated) StorageUtil.set("uiSettings", uiSettings);
  }, [uiSettings]);

  useEffect(() => {
    const list = Object.keys(configStore).map((key) => ({
      id: key,
      name: configStore[key].name,
      settings: configStore[key],
    }));

    const tabOrder = StorageUtil.get("tabOrder");
    if (tabOrder && tabOrder.length) {
      list.sort((a, b) => {
        const ia = tabOrder.indexOf(a.id);
        const ib = tabOrder.indexOf(b.id);
        if (ia === -1 && ib === -1) return 0;
        if (ia === -1) return 1;
        if (ib === -1) return -1;
        return ia - ib;
      });
    }

    setProfiles(list);
    setActiveProfile((prev) => {
      if (list.length === 0) return prev;
      return list.find((profile) => profile.id === prev?.id) ?? list[0];
    });
  }, [configStore]);

  useEffect(() => {
    setReady(
      authPhase === "authenticated" && allDataInitialized && activeProfile !== null && !initiating
    );
  }, [authPhase, allDataInitialized, setReady, activeProfile, initiating]);

  useEffect(() => {
    if (!__WITH_ANDROID__ || authPhase !== "authenticated" || !activeProfile?.id) return;
    fetch(`${resolveHttpBase()}/android/active-config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config_id: activeProfile.id }),
    }).catch((error) => {
      console.warn("[android] failed to sync active config", error);
    });
  }, [activeProfile?.id, authPhase]);

  const value = {
    profiles,
    uiSettings,
    setUiSettings,
    activeProfile,
    setActiveProfile,
  };

  return (
    <AppContext.Provider value={value}>
      <GlobalSelectProvider>{children}</GlobalSelectProvider>
    </AppContext.Provider>
  );
};

/** Coordinates the use app hook behavior. */
export const useApp = (): AppContextType => {
  const context = useContext(AppContext);
  if (context === undefined) {
    throw new Error("useApp must be used within an AppProvider");
  }
  return context;
};

import React, {createContext, ReactNode, useContext, useEffect, useState} from 'react';
import type {ConfigProfile, UISettings} from '@/types/app';
import {GlobalSelectProvider} from "@/components/ui/select-global"
import {useWebSocketStore} from "@/store/websocketStore.ts";

import {StorageUtil} from "@/lib/storage.ts";
import {useTranslation} from "react-i18next";

interface AppContextType {
  uiSettings: UISettings;
  setUiSettings: React.Dispatch<React.SetStateAction<UISettings>>;
  profiles: ConfigProfile[];
  activeProfile: ConfigProfile | null;
  setActiveProfile: (profile: ConfigProfile | null) => void;
}

const DEFAULT_UI_SETTINGS = {
  lang: "",
  theme: "",
  zoomScale: 100,
  scrollToEnd: true,
  assetsDisplay: true
}

const AppContext = createContext<AppContextType | undefined>(undefined);

function createResource<T>(promise: Promise<T>) {
  let status = "pending";
  let result: T;
  let suspender = promise.then(
    (r) => {
      status = "success";
      result = r;
    },
    (e) => {
      status = "error";
      result = e;
    }
  );
  return {
    read(): T {
      if (status === "pending") throw suspender;
      if (status === "error") throw result;
      return result!;
    },
  };
}

const init = useWebSocketStore.getState().init;
const configRes = createResource(init())


export const AppProvider: React.FC<{ children: ReactNode, setReady: (value: boolean) => void }> = (
  {
    children,
    setReady
  }
) => {
  const [profiles, setProfiles] = useState<ConfigProfile[]>([]);
  const [activeProfile, setActiveProfile] = useState<ConfigProfile | null>(null);

  const [uiSettings, setUiSettings] = useState<UISettings>(DEFAULT_UI_SETTINGS);
  const {i18n} = useTranslation();


  configRes.read()

  const configStore = useWebSocketStore((s) => s.configStore);

  useEffect(() => {
    const _uiSettings: UISettings | null = StorageUtil.get("uiSettings")
    if (!_uiSettings) {

      setUiSettings(DEFAULT_UI_SETTINGS);
      StorageUtil.set("uiSettings", DEFAULT_UI_SETTINGS);
    } else {
      setUiSettings(_uiSettings);
      i18n.changeLanguage(_uiSettings.lang)
    }
  }, []);

  useEffect(() => {
    if (uiSettings) StorageUtil.set("uiSettings", uiSettings);
  }, [uiSettings]);


  useEffect(() => {
    const list = Object.keys(configStore).map((key) => ({
      id: key,
      name: configStore[key].name,
      settings: configStore[key],
    }));

    if (list.length > 0 && !activeProfile) {
      (async () => {
        const tabOrder = await StorageUtil.get("tabOrder");
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
        setActiveProfile(list[0]);
      })();
    }

    setProfiles(list);
  }, [configStore]);

  useEffect(() => {
    setReady(true);
  }, []);

  const value = {
    profiles,
    uiSettings,
    setUiSettings,
    activeProfile,
    setActiveProfile
  };


  return (
    <AppContext.Provider value={value}>
      <GlobalSelectProvider>
        {children}
      </GlobalSelectProvider>
    </AppContext.Provider>
  );
};

export const useApp = (): AppContextType => {
  const context = useContext(AppContext);
  if (context === undefined) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
};

import React, { createContext, ReactNode, useContext, useEffect, useMemo, useState } from "react";
import type { ConfigProfileSummary } from "@/types/app";
import { GlobalSelectProvider } from "@/components/ui/SelectGlobal";
import { resolveHttpBase, useWebSocketStore } from "@/store/WebsocketStore";
import { useShallow } from "zustand/react/shallow";

import StorageUtil from "@/shared/StorageManager.ts";

interface AppContextType {
  profiles: ConfigProfileSummary[];
  activeProfile: ConfigProfileSummary | null;
  setActiveProfile: (profile: ConfigProfileSummary | null) => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

/** Renders the app provider component. */
export const AppProvider: React.FC<{ children: ReactNode; setReady: (value: boolean) => void }> = ({
  children,
  setReady,
}) => {
  const [activeProfile, setActiveProfile] = useState<ConfigProfileSummary | null>(null);
  const init = useWebSocketStore((s) => s.init);
  const authPhase = useWebSocketStore((s) => s._auth_phase);
  const allDataInitialized = useWebSocketStore((s) => s._all_data_initialized);
  const initiating = useWebSocketStore((s) => s._initiating);
  const profileEntries = useWebSocketStore(
    useShallow((state) =>
      Object.entries(state.configStore).map(([id, config]: [string, any]) =>
        JSON.stringify([id, String(config.name ?? "")])
      )
    )
  );
  const unsortedProfiles = useMemo<ConfigProfileSummary[]>(
    () =>
      profileEntries.map((entry) => {
        const [id, name] = JSON.parse(entry) as [string, string];
        return { id, name };
      }),
    [profileEntries]
  );
  const profiles = useMemo(() => {
    const list = [...unsortedProfiles];
    const tabOrder = StorageUtil.get<string[]>("tabOrder");
    if (!tabOrder?.length) return list;
    return list.sort((a, b) => {
      const ia = tabOrder.indexOf(a.id);
      const ib = tabOrder.indexOf(b.id);
      if (ia === -1 && ib === -1) return 0;
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
  }, [unsortedProfiles]);

  useEffect(() => {
    if (authPhase === "authenticated" && !allDataInitialized) {
      void init();
    }
  }, [authPhase, allDataInitialized, init]);

  useEffect(() => {
    setActiveProfile((prev) => {
      if (profiles.length === 0) return prev;
      return profiles.find((profile) => profile.id === prev?.id) ?? profiles[0];
    });
  }, [profiles]);

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

  const value = useMemo(
    () => ({ profiles, activeProfile, setActiveProfile }),
    [activeProfile, profiles]
  );

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

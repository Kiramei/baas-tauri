import React, { createContext, ReactNode, useCallback, useContext, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { getTimestampMs } from "@/shared/GlobalUtilities";
import { useWebSocketStore, waitForNormal } from "@/store/WebsocketStore";

interface TauriSelfUpdateContextType {
  updating: boolean;
  progress: number;
  status: string;
  progressOpen: boolean;
  setProgressOpen: React.Dispatch<React.SetStateAction<boolean>>;
  runUpdate: () => Promise<void>;
}

const TauriSelfUpdateContext = createContext<TauriSelfUpdateContextType | undefined>(undefined);

export const TauriSelfUpdateProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { t } = useTranslation();
  const trigger = useWebSocketStore((state) => state.trigger);
  const [updating, setUpdating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("");
  const [progressOpen, setProgressOpen] = useState(false);

  const stopAllTasks = useCallback(async () => {
    trigger({
      timestamp: getTimestampMs(),
      command: "stop_all_tasks",
      payload: {},
    });
    await waitForNormal(
      () => useWebSocketStore.getState().statusStore,
      (statuses) => Object.values(statuses).every((item: any) => !item?.running),
      15_000
    );
  }, [trigger]);

  const runUpdate = useCallback(async (): Promise<void> => {
    if (!__WITH_TAURI__) return;
    setUpdating(true);
    setProgressOpen(true);
    setProgress(0);
    setStatus(t("update.tauriChecking"));
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const { relaunch } = await import("@tauri-apps/plugin-process");
      const update = await check();
      if (!update) {
        setStatus(t("update.tauriUpToDate"));
        toast.success(t("update.tauriUpToDate"));
        return;
      }
      await stopAllTasks();
      let downloaded = 0;
      let contentLength = 0;
      setStatus(t("update.tauriDownloading", { version: update.version }));
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          contentLength = event.data.contentLength ?? 0;
          downloaded = 0;
          setProgress(0);
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          if (contentLength > 0) {
            setProgress(Math.min(100, Math.round((downloaded / contentLength) * 100)));
          }
        } else if (event.event === "Finished") {
          setProgress(100);
          setStatus(t("update.tauriInstalling"));
        }
      });
      await relaunch();
    } catch (error) {
      setStatus(t("update.tauriFailed"));
      toast.error(t("update.tauriFailed"), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setUpdating(false);
    }
  }, [stopAllTasks, t]);

  return (
    <TauriSelfUpdateContext.Provider
      value={{
        updating,
        progress,
        status,
        progressOpen,
        setProgressOpen,
        runUpdate,
      }}
    >
      {children}
    </TauriSelfUpdateContext.Provider>
  );
};

export const useTauriSelfUpdate = (): TauriSelfUpdateContextType => {
  const context = useContext(TauriSelfUpdateContext);

  if (context === undefined) {
    throw new Error("useTauriSelfUpdate must be used within a TauriSelfUpdateProvider");
  }

  return context;
};

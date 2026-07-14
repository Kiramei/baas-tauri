import React, { createContext, ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { getTimestampMs } from "@/shared/GlobalUtilities";
import { isTauriNoUpdateEnabled, useWebSocketStore, waitForNormal } from "@/store/WebsocketStore";

interface TauriSelfUpdateContextType {
  updating: boolean;
  progress: number;
  status: string;
  progressOpen: boolean;
  setProgressOpen: React.Dispatch<React.SetStateAction<boolean>>;
  runUpdate: () => Promise<void>;
}

const TauriSelfUpdateContext = createContext<TauriSelfUpdateContextType | undefined>(undefined);

/** Renders the tauri self update provider component. */
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
    if (__WITH_ANDROID__) {
      const state = useWebSocketStore.getState();
      const updateUrl = state.versionStore?.tauri?.url;
      if (updateUrl) {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(updateUrl);
        return;
      }
      await state.checkTauriUpdater(false, true);
      toast.info(t("update.tauriUpToDate"));
      return;
    }
    if (await isTauriNoUpdateEnabled()) {
      toast.info(t("update.tauriUpToDate"));
      return;
    }
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

  const value = useMemo(
    () => ({ updating, progress, status, progressOpen, setProgressOpen, runUpdate }),
    [progress, progressOpen, runUpdate, status, updating]
  );

  return (
    <TauriSelfUpdateContext.Provider value={value}>{children}</TauriSelfUpdateContext.Provider>
  );
};

/** Coordinates the use tauri self update hook behavior. */
export const useTauriSelfUpdate = (): TauriSelfUpdateContextType => {
  const context = useContext(TauriSelfUpdateContext);

  if (context === undefined) {
    throw new Error("useTauriSelfUpdate must be used within a TauriSelfUpdateProvider");
  }

  return context;
};

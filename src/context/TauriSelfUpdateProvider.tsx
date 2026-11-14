import React, {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { getTimestampMs } from "@/shared/GlobalUtilities";
import { isTauriNoUpdateEnabled, useWebSocketStore, waitForNormal } from "@/store/WebsocketStore";
import IdleBackendUpdater from "@/components/IdleBackendUpdater";

const TauriUpdateProgressModal = React.lazy(() =>
  import("@/components/updater/TauriUpdateProgressModal").then((module) => ({
    default: module.TauriUpdateProgressModal,
  }))
);

type ClientUpdateEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

interface TauriSelfUpdateContextType {
  updating: boolean;
  runUpdate: () => Promise<void>;
}

const TauriSelfUpdateContext = createContext<TauriSelfUpdateContextType | undefined>(undefined);

/** Renders the tauri self update provider component. */
export const TauriSelfUpdateProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { t } = useTranslation();
  const trigger = useWebSocketStore((state) => state.trigger);
  const [updating, setUpdating] = useState(false);
  const running = useRef(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
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
    if (!__WITH_TAURI__ || running.current) return;
    running.current = true;
    setUpdating(true);
    setProgressOpen(true);
    setProgress(null);
    setErrorDetail(null);
    setStatus(t("update.tauriChecking"));
    try {
      if (await isTauriNoUpdateEnabled()) {
        setStatus(t("update.tauriDisabled"));
        return;
      }
      const [{ invoke }, { Channel }] = await Promise.all([
        import("@/shared/TauriInvoke"),
        import("@tauri-apps/api/core"),
      ]);
      const version = useWebSocketStore.getState().versionStore?.tauri?.version;
      if (!version) {
        setStatus(t("update.tauriUpToDate"));
        toast.success(t("update.tauriUpToDate"));
        return;
      }
      await stopAllTasks();
      let downloaded = 0;
      let contentLength = 0;
      setStatus(t("update.tauriDownloading", { version }));
      const onEvent = new Channel<ClientUpdateEvent>();
      onEvent.onmessage = (event) => {
        if (event.event === "Started") {
          contentLength = event.data.contentLength ?? 0;
          downloaded = 0;
          setProgress(contentLength > 0 ? 0 : null);
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          if (contentLength > 0) {
            setProgress(Math.min(100, Math.round((downloaded / contentLength) * 100)));
          }
        } else if (event.event === "Finished") {
          setProgress(100);
          if (!__WITH_ANDROID__) setStatus(t("update.tauriInstalling"));
        }
      };
      const updateStarted = await invoke<boolean>("tauri_client_download_and_install", { onEvent });
      if (!updateStarted) {
        void useWebSocketStore.getState().checkTauriUpdater();
        setStatus(t("update.tauriUpToDate"));
        toast.success(t("update.tauriUpToDate"));
        return;
      }
      if (__WITH_ANDROID__) {
        setProgress(100);
        setStatus(t("update.androidInstallerOpened"));
        return;
      }
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (error) {
      setErrorDetail(error instanceof Error ? error.message : String(error));
      setStatus(t("update.tauriFailed"));
    } finally {
      running.current = false;
      setUpdating(false);
    }
  }, [stopAllTasks, t]);

  const value = useMemo(() => ({ updating, runUpdate }), [runUpdate, updating]);

  return (
    <TauriSelfUpdateContext.Provider value={value}>
      <IdleBackendUpdater clientUpdating={updating} />
      {children}
      {progressOpen && (
        <React.Suspense fallback={null}>
          <TauriUpdateProgressModal
            onClose={() => setProgressOpen(false)}
            updating={updating}
            progress={progress}
            status={status}
            errorDetail={errorDetail}
            onRetry={runUpdate}
          />
        </React.Suspense>
      )}
    </TauriSelfUpdateContext.Provider>
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

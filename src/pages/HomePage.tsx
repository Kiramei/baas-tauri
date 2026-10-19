import { IconTooltip } from "@/components/ui/Tooltip";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useAppTranslation } from "@/shared/useAppTranslation";
import { useApp } from "@/context/AppContext";
import CButton from "@/components/ui/CButton.tsx";
import Logger from "@/components/ui/Logger";
import AssetsDisplay from "@/components/AssetsDisplay";
import { ArrowDownToLine, FileDown, Keyboard, Logs, Play, Square, Webcam } from "lucide-react";
import { LogItem, ProfileProps } from "@/types/app";
import { TaskStatus } from "@/components/HomeTaskStatus.tsx";
import { useWebSocketStore } from "@/store/WebsocketStore";
import { formatIsoToReadable, getTimestampMs } from "@/shared/GlobalUtilities.ts";
import { useSetUISettings, useUISetting } from "@/context/UISettingsProvider.tsx";
import { RemoteDisplay } from "@/components/RemoteDisplay.tsx";
import StorageUtil from "@/shared/StorageManager.ts";
import { HotkeySettingsModal } from "@/components/HotkeyConfig.tsx";
import { useTauriShortcuts } from "@/context/TauriShortcutProvider.tsx";
import { toast } from "sonner";
import { buildServerOptions } from "@/shared/serverOptions";
import { useAndroidStartGuard } from "@/android/components/AndroidStartGuard";
import { Modal } from "@/components/ui/Modal";
import {
  androidPackageForServer,
  androidProfileGameSession,
  isAndroidProfileDisplayReady,
  otherRunningAndroidProfiles,
  resolveAndroidProfileGame,
  type AndroidInstalledGame,
} from "@/shared/AndroidProfileGame";

const EMPTY_LOGS: LogItem[] = [];
const AndroidGamePanel = React.lazy(() => import("@/android/components/AndroidGamePanel"));
const TOOL_BUTTON_CLASS =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-40";

/**
 * Landing experience for a profile that provides orchestration controls, status, and live logs.
 */
const HomePage: React.FC<ProfileProps> = ({ profileId }) => {
  const { t } = useAppTranslation();
  const scrollToEnd = useUISetting((settings) => settings.scrollToEnd);
  const assetsDisplay = useUISetting((settings) => settings.assetsDisplay);
  const setUiSettings = useSetUISettings();
  const { hotkeys, saveHotkeys, setShortcutsSuspended } = useTauriShortcuts();
  const { profiles, activeProfile } = useApp();
  const pid = profileId ?? activeProfile?.id;
  const profile = useMemo(
    () => profiles.find((p) => p.id === pid) ?? activeProfile ?? null,
    [profiles, pid, activeProfile]
  );
  const activeConfigId = profile?.id ?? pid;

  const scriptRunning = useWebSocketStore((state) =>
    activeConfigId ? state.statusStore[activeConfigId]?.running || false : false
  );
  const settings = useWebSocketStore((state) =>
    activeConfigId ? state.configStore[activeConfigId] : undefined
  );
  const activeLogs = useWebSocketStore((state) =>
    activeConfigId ? (state.logStore[`config:${activeConfigId}`] ?? EMPTY_LOGS) : EMPTY_LOGS
  );
  const remoteAvailable = !__WITH_ANDROID__;
  const hotkeyAvailable = __WITH_TAURI__ && !__WITH_ANDROID__;
  const isAndroid = __WITH_ANDROID__;
  const [remoteVisible, setRemoteVisible] = useState<boolean>(false);
  const [hotkeyOpen, setHotkeyOpen] = useState(false);
  const [androidVirtualDisplayBusy, setAndroidVirtualDisplayBusy] = useState(false);
  const [androidVirtualDisplayActive, setAndroidVirtualDisplayActive] = useState(false);
  const [androidGameIssue, setAndroidGameIssue] = useState<{
    unsupported: boolean;
    server: string;
    packageName?: string;
  } | null>(null);
  const [androidBlockingProfiles, setAndroidBlockingProfiles] = useState<string[]>([]);
  const androidDisplayBinding = useSyncExternalStore(
    androidProfileGameSession.subscribe,
    androidProfileGameSession.getSnapshot,
    androidProfileGameSession.getSnapshot
  );
  const androidDisplayOperation = useRef(false);
  const androidStartGuard = useAndroidStartGuard(
    isAndroid && __WITH_TAURI__ && activeProfile?.id === activeConfigId
  );
  const androidBusy = androidVirtualDisplayBusy || androidStartGuard.busy;

  const androidGamePackage = androidPackageForServer(settings?.server);
  const androidDisplayMatchesProfile = Boolean(
    androidVirtualDisplayActive &&
    androidDisplayBinding?.profileId === activeConfigId &&
    androidDisplayBinding?.packageName === androidGamePackage
  );
  const serverLabel = buildServerOptions(t).find(
    (server) => server.value === settings?.server
  )?.label;
  const showServerLabel = Boolean(serverLabel && serverLabel !== profile?.name);

  const adbSerial = useMemo(() => {
    if (__WITH_ANDROID__) {
      return window.localStorage.getItem("baasAndroidAdbSerial")?.trim() || "auto";
    }
    const adbIP = String(settings?.adbIP ?? "").trim();
    const adbPort = String(settings?.adbPort ?? "").trim();
    if (adbIP && adbPort) return `${adbIP}:${adbPort}`;
    return adbPort || adbIP || "emulator-5556";
  }, [settings?.adbIP, settings?.adbPort]);

  const refreshAndroidVirtualDisplayStatus = useCallback(async () => {
    if (!__WITH_ANDROID__ || !__WITH_TAURI__) return false;
    try {
      const { invoke } = await import("@/shared/TauriInvoke");
      const status = await invoke<{ active: boolean; displayId?: number | null }>(
        "android_scrcpy_virtual_display_status",
        { serial: adbSerial }
      );
      const profilePackage = androidPackageForServer(
        useWebSocketStore.getState().configStore[activeConfigId ?? ""]?.server
      );
      const ready = isAndroidProfileDisplayReady(
        androidProfileGameSession.getSnapshot(),
        activeConfigId,
        profilePackage,
        status
      );
      setAndroidVirtualDisplayActive(ready);
      return ready;
    } catch (error) {
      console.warn("Android background display status failed", error);
      return false;
    }
  }, [adbSerial, activeConfigId]);

  const requireAndroidProfileGame = async (): Promise<AndroidInstalledGame | null> => {
    const server = useWebSocketStore.getState().configStore[activeConfigId ?? ""]?.server;
    try {
      const { invoke } = await import("@/shared/TauriInvoke");
      const report = await invoke<{ games: AndroidInstalledGame[] }>("android_list_games");
      const result = resolveAndroidProfileGame(server, report.games);
      if (result.state !== "ready") {
        const label = buildServerOptions(t).find((item) => item.value === server)?.label;
        setAndroidGameIssue({
          unsupported: result.state === "unsupported",
          server: label ?? String(server ?? ""),
          packageName: result.state === "missing" ? result.packageName : undefined,
        });
        return null;
      }
      return result.game;
    } catch (error) {
      toast.error(t("android.game.inspectFailed"), { description: String(error) });
      return null;
    }
  };

  const requireAndroidRunSlot = (): boolean => {
    const running = otherRunningAndroidProfiles(
      useWebSocketStore.getState().statusStore,
      activeConfigId
    );
    setAndroidBlockingProfiles(running);
    return running.length === 0;
  };

  const changeAndroidVirtualDisplay = async (
    value: boolean,
    packageName?: string
  ): Promise<boolean> => {
    if (!__WITH_ANDROID__ || !__WITH_TAURI__ || androidDisplayOperation.current) return false;
    // Recheck after permission/game checks, before native prepare can force-stop
    // the shared game or cleanup can remove another scheduler's display.
    if (!requireAndroidRunSlot()) return false;
    androidDisplayOperation.current = true;
    setAndroidVirtualDisplayBusy(true);
    try {
      const { invoke } = await import("@/shared/TauriInvoke");
      if (value) {
        let report: { displayId: number; serial: string; packageName: string } | undefined;
        for (let attempt = 0; attempt < 4; attempt += 1) {
          try {
            report = await invoke("android_prepare_scrcpy_virtual_display", {
              request: {
                serial: adbSerial,
                configId: activeConfigId,
                packageName,
                width: 1280,
                height: 720,
                density: 240,
              },
            });
            break;
          } catch (error) {
            const message = String(error);
            const connecting =
              message.includes("still connecting") || message.includes("Timed out connecting");
            if (!connecting || attempt === 3) throw error;
            await new Promise((resolve) => window.setTimeout(resolve, 1_200));
          }
        }
        if (!report) throw new Error(t("android.start.displayNotReady"));
        if (!activeConfigId || report.packageName !== packageName) {
          throw new Error(t("android.start.displayNotReady"));
        }
        androidProfileGameSession.claim({
          profileId: activeConfigId,
          packageName: report.packageName,
          displayId: report.displayId,
        });
        setAndroidVirtualDisplayActive(true);
        toast.success(t("android.start.displayOpened"));
      } else {
        if (scriptRunning && activeConfigId) {
          useWebSocketStore.getState().trigger({
            timestamp: getTimestampMs(),
            command: "stop_scheduler",
            config_id: activeConfigId,
            payload: {},
          });
        }
        await invoke("android_cleanup_scrcpy_virtual_display", { serial: adbSerial });
        androidProfileGameSession.clear();
        setAndroidVirtualDisplayActive(false);
        toast.success(t("android.start.displayClosed"));
      }
      void refreshAndroidVirtualDisplayStatus();
      return true;
    } catch (error) {
      toast.error(value ? t("android.start.displayFailed") : t("android.start.cleanupFailed"), {
        description: String(error),
      });
      void refreshAndroidVirtualDisplayStatus();
      return false;
    } finally {
      androidDisplayOperation.current = false;
      setAndroidVirtualDisplayBusy(false);
    }
  };

  const toggleAndroidVirtualDisplay = (value: boolean, packageName?: string): Promise<boolean> => {
    if (!requireAndroidRunSlot()) return Promise.resolve(false);
    return value
      ? androidStartGuard.run(async () => {
          const game = await requireAndroidProfileGame();
          if (!game) return false;
          return changeAndroidVirtualDisplay(true, game.packageName);
        })
      : androidStartGuard.run(() => changeAndroidVirtualDisplay(false, packageName), "stop");
  };

  useEffect(() => {
    if (activeProfile?.id === activeConfigId) void refreshAndroidVirtualDisplayStatus();
  }, [
    activeProfile?.id,
    activeConfigId,
    androidDisplayBinding,
    refreshAndroidVirtualDisplayStatus,
  ]);

  /**
   * Issues the scheduler start command for the active profile.
   * Guarded against duplicate submissions when a run is already active.
   */
  const startScript = async () => {
    if (!profile || !activeConfigId || scriptRunning || androidBusy) return;
    const dispatchStart = () =>
      useWebSocketStore.getState().trigger(
        {
          timestamp: getTimestampMs(),
          command: "start_scheduler",
          config_id: activeConfigId,
          payload: {},
        },
        (response) => {
          console.debug("start_scheduler acknowledged", response);
          if ((response as any)?.status === "error") {
            toast.error(t("android.start.scriptFailed"), {
              description: String((response as any)?.message ?? (response as any)?.error ?? ""),
            });
          }
        }
      );
    if (__WITH_ANDROID__ && __WITH_TAURI__) {
      if (!requireAndroidRunSlot()) return;
      await androidStartGuard.run(async () => {
        const game = await requireAndroidProfileGame();
        if (!game) return false;
        // An old preview can remain marked active after Shizuku has stopped.
        // Check its native state only after the fresh permission check passed.
        if (!(await refreshAndroidVirtualDisplayStatus())) {
          const prepared = await changeAndroidVirtualDisplay(true, game.packageName);
          if (!prepared || !(await refreshAndroidVirtualDisplayStatus())) return false;
        }
        if (!requireAndroidRunSlot()) return false;
        dispatchStart();
        return true;
      });
      return;
    }
    dispatchStart();
  };

  /**
   * Sends a stop signal to the scheduler for the active profile.
   */
  const stopScript = () => {
    if (!profile || !activeConfigId || !scriptRunning) return;
    useWebSocketStore.getState().trigger(
      {
        timestamp: getTimestampMs(),
        command: "stop_scheduler",
        config_id: activeConfigId,
        payload: {},
      },
      (response) => {
        console.debug("stop_scheduler acknowledged", response);
      }
    );
  };

  useEffect(() => {
    if (!__WITH_ANDROID__) return;
    const toggleRun = () => {
      // Home stays mounted per profile so the bottom action also works from
      // Settings and Configuration. Cached profiles must never receive it.
      if (activeProfile?.id !== activeConfigId) return;
      if (scriptRunning) stopScript();
      else void startScript();
    };
    window.addEventListener("baas:toggle-primary-run", toggleRun);
    return () => window.removeEventListener("baas:toggle-primary-run", toggleRun);
  });

  /**
   * Serializes the on-screen log buffer and triggers a local download for auditing or support.
   */
  const pad = (n: number) => n.toString().padStart(2, "0");
  const exportLog = async () => {
    const content = activeLogs
      .map((entry) => `[${formatIsoToReadable(entry.time)}] ${entry.level}: ${entry.message}`)
      .join("\n");
    const now = new Date();
    const formattedDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    await StorageUtil.download(
      `logs-${activeConfigId ?? "profile"}-${formattedDate}.txt`,
      content,
      t
    );
  };

  return (
    <div
      className={`flex h-full min-h-0 min-w-0 flex-col text-foreground ${isAndroid ? "gap-2" : "gap-5"}`}
    >
      {!isAndroid && (
        <div className="flex min-w-0 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2.5">
              <h1 className="min-w-0 truncate text-[16px] font-medium leading-6 tracking-[-0.01em]">
                {profile?.name ?? t("nav.home")}
              </h1>
              {showServerLabel && (
                <span className="shrink-0 rounded-md bg-secondary/70 px-1.5 py-0.5 text-[10px] leading-4 text-muted-foreground">
                  {serverLabel}
                </span>
              )}
            </div>
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-1">
            {remoteAvailable && (
              <IconTooltip content={t("remote.emulator")}>
                <button
                  type="button"
                  onClick={() => setRemoteVisible((visible) => !visible)}
                  aria-label={t("remote.emulator")}
                  aria-pressed={remoteVisible}
                  className={`${TOOL_BUTTON_CLASS} ${remoteVisible ? "bg-secondary text-foreground" : ""}`}
                >
                  <Webcam className="h-4 w-4" strokeWidth={1.6} />
                </button>
              </IconTooltip>
            )}
            {hotkeyAvailable && (
              <IconTooltip content={t("hotkey")}>
                <button
                  type="button"
                  onClick={() => setHotkeyOpen(true)}
                  aria-label={t("hotkey")}
                  className={TOOL_BUTTON_CLASS}
                >
                  <Keyboard className="h-4 w-4" strokeWidth={1.6} />
                </button>
              </IconTooltip>
            )}
            <CButton
              onClick={scriptRunning ? stopScript : startScript}
              aria-label={scriptRunning ? t("common.stop") : t("common.start")}
              variant={scriptRunning ? "danger" : "primary"}
              className="ml-2 h-8.5 gap-1.5 rounded-lg px-3.5 py-0 text-xs"
              disabled={androidBusy}
            >
              {scriptRunning ? (
                <Square className="h-3 w-3" fill="currentColor" strokeWidth={1.6} />
              ) : (
                <Play className="h-3.5 w-3.5" fill="currentColor" strokeWidth={1.6} />
              )}
              {androidBusy
                ? t("home.preparing")
                : scriptRunning
                  ? t("common.stop")
                  : t("common.start")}
            </CButton>
          </div>
        </div>
      )}

      {hotkeyAvailable && (
        <HotkeySettingsModal
          isOpen={hotkeyOpen}
          value={hotkeys}
          onRecordingChange={setShortcutsSuspended}
          onClose={async (toSave, draft) => {
            setShortcutsSuspended(false);
            if (!toSave) {
              setHotkeyOpen(false);
              return;
            }

            const report = await saveHotkeys(draft ?? hotkeys);
            if (report.rejected.length > 0) {
              toast.error(t("hotkey.fixInvalid"), {
                description: report.rejected
                  .map((item) => `${item.accelerator}: ${item.reason}`)
                  .join("; "),
              });
              return;
            }
            setHotkeyOpen(false);
            toast.success(t("settings.updateSuccess"));
          }}
        />
      )}

      {isAndroid && __WITH_TAURI__ && (
        <React.Suspense
          fallback={<div className="h-14 shrink-0 animate-pulse rounded-xl bg-secondary" />}
        >
          <AndroidGamePanel
            configuredPackage={androidGamePackage}
            virtualDisplayActive={androidDisplayMatchesProfile}
            virtualDisplayBusy={androidBusy}
            onToggleVirtualDisplay={async (active, packageName) => {
              await toggleAndroidVirtualDisplay(active, packageName);
            }}
          />
        </React.Suspense>
      )}

      {androidStartGuard.dialog}

      <Modal
        isOpen={isAndroid && activeProfile?.id === activeConfigId && androidGameIssue !== null}
        onClose={() => setAndroidGameIssue(null)}
        title={
          androidGameIssue?.unsupported
            ? t("android.start.unsupportedGameTitle")
            : t("android.start.missingGameTitle")
        }
      >
        <p className="text-sm leading-6 text-muted-foreground">
          {androidGameIssue?.unsupported
            ? t("android.start.unsupportedGameDescription", {
                profile: profile?.name,
                server: androidGameIssue.server,
              })
            : t("android.start.missingGameDescription", {
                profile: profile?.name,
                server: androidGameIssue?.server,
              })}
        </p>
        {androidGameIssue?.packageName && (
          <p className="mt-3 break-all font-mono text-xs text-muted-foreground">
            {androidGameIssue.packageName}
          </p>
        )}
        <div className="modal-footer">
          <CButton onClick={() => setAndroidGameIssue(null)}>{t("common.close")}</CButton>
        </div>
      </Modal>

      <Modal
        isOpen={
          isAndroid && activeProfile?.id === activeConfigId && androidBlockingProfiles.length > 0
        }
        onClose={() => setAndroidBlockingProfiles([])}
        title={t("android.start.otherProfileRunningTitle")}
      >
        <p className="text-sm leading-6 text-muted-foreground">
          {t("android.start.otherProfileRunningDescription", {
            profiles: androidBlockingProfiles
              .map((id) => profiles.find((item) => item.id === id)?.name ?? id)
              .join(", "),
            profile: profile?.name,
          })}
        </p>
        <div className="modal-footer">
          <CButton onClick={() => setAndroidBlockingProfiles([])}>{t("common.close")}</CButton>
        </div>
      </Modal>

      {/* Account data and task context share one compact summary area. */}
      {activeConfigId && (
        <div className={`min-w-0 shrink-0 ${isAndroid ? "space-y-2" : "space-y-5"}`}>
          {isAndroid && <TaskStatus profileId={activeConfigId} />}
          {assetsDisplay && <AssetsDisplay profileId={activeConfigId} />}
          {!isAndroid && <TaskStatus profileId={activeConfigId} />}
        </div>
      )}

      {/* Logs form the main workspace; controls stay quiet until they are needed. */}
      <section
        className={`home-log-workspace home-log-surface flex min-w-0 flex-1 flex-col overflow-hidden rounded-[14px] bg-(--log-surface) shadow-(--log-card-shadow) ${isAndroid ? "min-h-0" : "min-h-64"}`}
      >
        <div className="home-log-toolbar flex shrink-0 items-center justify-between gap-3 px-3 py-2.5 border-b border-b-(--workspace-divider)">
          <h2 className="flex min-w-0 items-center gap-2 text-[13px] font-medium leading-5">
            <Logs className="h-3.5 w-3.5 text-muted-foreground" strokeWidth={1.6} />
            {t("log")}
            {activeLogs.length > 0 && (
              <span className="ml-0.5 text-[11px] font-normal tabular-nums text-muted-foreground">
                {activeLogs.length.toLocaleString()}
              </span>
            )}
          </h2>
          <div className="flex shrink-0 items-center gap-1">
            <IconTooltip content={t("log.scroll.detail")}>
              <button
                type="button"
                onClick={() => setUiSettings((state) => ({ ...state, scrollToEnd: !scrollToEnd }))}
                aria-label={t("log.scroll")}
                aria-pressed={scrollToEnd}
                className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${scrollToEnd ? "bg-secondary/70 text-foreground" : "text-muted-foreground"}`}
              >
                <ArrowDownToLine className="h-3.5 w-3.5" strokeWidth={1.6} />
              </button>
            </IconTooltip>
            <IconTooltip content={t("log.export")}>
              <button
                type="button"
                onClick={exportLog}
                aria-label={t("log.export")}
                className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <FileDown className="h-3.5 w-3.5" strokeWidth={1.6} />
              </button>
            </IconTooltip>
          </div>
        </div>
        <div className="home-log-body relative flex min-h-0 min-w-0 flex-1 overflow-hidden py-2 px-2">
          {remoteAvailable && remoteVisible && activeConfigId && (
            <RemoteDisplay profileId={activeConfigId} />
          )}
          <Logger logs={activeLogs} scrollToEnd={scrollToEnd} />
        </div>
      </section>
    </div>
  );
};

export default HomePage;

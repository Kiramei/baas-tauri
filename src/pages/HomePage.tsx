import { IconTooltip } from "@/components/ui/Tooltip";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApp } from "@/context/AppContext";
import CButton from "@/components/ui/CButton.tsx";
import Logger from "@/components/ui/Logger";
import AssetsDisplay from "@/components/AssetsDisplay";
import { Card, CardContent } from "@/components/ui/Card";
import {
  ArrowDownToLine,
  FileDown,
  Keyboard,
  ListEnd,
  Logs,
  Play,
  Square,
  Webcam,
} from "lucide-react";
import SwitchButton from "@/components/ui/SwitchButton.tsx";
import { LogItem, ProfileProps } from "@/types/app";
import { TaskStatus } from "@/components/HomeTaskStatus.tsx";
import { useWebSocketStore } from "@/store/WebsocketStore";
import { formatIsoToReadable, getTimestampMs } from "@/shared/GlobalUtilities.ts";
import { useSetUISettings, useUISetting } from "@/context/UISettingsProvider.tsx";
import { RemoteDisplay } from "@/components/RemoteDisplay.tsx";
import { AndroidVirtualDisplayPreview } from "@/components/AndroidVirtualDisplayPreview.tsx";
import { Modal } from "@/components/ui/Modal.tsx";
import StorageUtil from "@/shared/StorageManager.ts";
import { HotkeySettingsModal } from "@/components/HotkeyConfig.tsx";
import { useTauriShortcuts } from "@/context/TauriShortcutProvider.tsx";
import { toast } from "sonner";
import { buildServerOptions, SERVER_VALUES } from "@/shared/serverOptions";

const EMPTY_LOGS: LogItem[] = [];
const TOOL_BUTTON_CLASS =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-40";
const ANDROID_GAME_PACKAGES: Record<string, string> = {
  [SERVER_VALUES.CN_OFFICIAL]: "com.RoamingStar.BlueArchive",
  [SERVER_VALUES.CN_BILIBILI]: "com.RoamingStar.BlueArchive.bilibili",
  [SERVER_VALUES.GLOBAL]: "com.nexon.bluearchive",
  [SERVER_VALUES.GLOBAL_TEEN]: "com.nexon.bluearchiveteen",
  [SERVER_VALUES.KR_ONE]: "com.nexon.bluearchiveone",
  [SERVER_VALUES.JP]: "com.YostarJP.BlueArchive",
};

/**
 * Landing experience for a profile that provides orchestration controls, status, and live logs.
 */
const HomePage: React.FC<ProfileProps> = ({ profileId }) => {
  const { t } = useTranslation();
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
  const [androidLogOpen, setAndroidLogOpen] = useState(false);
  const [hotkeyOpen, setHotkeyOpen] = useState(false);
  const [androidVirtualDisplayBusy, setAndroidVirtualDisplayBusy] = useState(false);
  const [androidVirtualDisplayActive, setAndroidVirtualDisplayActive] = useState(false);

  const scrcpyVirtualDisplayEnabled = __WITH_ANDROID__ && androidVirtualDisplayActive;
  const androidGamePackage = ANDROID_GAME_PACKAGES[String(settings?.server ?? "")];
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

  const syncAndroidDeviceMethods = async (useScrcpy: boolean) => {
    if (!__WITH_ANDROID__ || !activeConfigId) return;
    const patch = useScrcpy
      ? {
          screenshot_method: "scrcpy",
          control_method: "scrcpy",
          adbIP: "127.0.0.1",
          adbPort: "5555",
        }
      : {
          screenshot_method: "android_local",
          control_method: "android_local",
        };
    const timestamp = getTimestampMs();
    const ops = Object.entries(patch).map(([key, value]) => ({
      op: "replace",
      path: `/${key}`,
      value,
    }));
    const store = useWebSocketStore.getState();
    await new Promise<void>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        delete useWebSocketStore.getState().pendingCallbacks[timestamp];
        reject(new Error("Android device method patch was not acknowledged"));
      }, 5000);
      store.pendingCallbacks[timestamp] = () => {
        window.clearTimeout(timeoutId);
        resolve();
      };
      store.send("sync", {
        type: "patch",
        resource_id: activeConfigId,
        resource: "config",
        timestamp,
        ops,
      });
    });
    const expectedMethod = useScrcpy ? "scrcpy" : "android_local";
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const current = useWebSocketStore.getState().configStore[activeConfigId];
      if (
        current?.screenshot_method === expectedMethod &&
        current?.control_method === expectedMethod
      ) {
        return;
      }
      useWebSocketStore.getState().send("sync", {
        type: "pull",
        resource: "config",
        resource_id: activeConfigId,
      });
      await new Promise((resolve) => window.setTimeout(resolve, 300));
    }
    throw new Error(`Android device methods did not switch to ${expectedMethod}`);
  };

  const refreshAndroidVirtualDisplayStatus = useCallback(async () => {
    if (!__WITH_ANDROID__) return false;
    try {
      const { invoke } = await import("@/shared/TauriInvoke");
      const status = await invoke<{ active: boolean; displayId?: number | null }>(
        "android_scrcpy_virtual_display_status",
        { serial: adbSerial }
      );
      setAndroidVirtualDisplayActive(Boolean(status.active));
      return Boolean(status.active);
    } catch (error) {
      console.warn("scrcpy virtual display status failed", error);
      return false;
    }
  }, [adbSerial]);

  const toggleAndroidVirtualDisplay = async (value: boolean): Promise<boolean> => {
    if (!__WITH_ANDROID__ || androidVirtualDisplayBusy) return false;
    setAndroidVirtualDisplayBusy(true);
    try {
      const { invoke } = await import("@/shared/TauriInvoke");
      if (value) {
        const report = await invoke<{
          displayId: number;
          serial: string;
          packageName: string;
        }>("android_prepare_scrcpy_virtual_display", {
          request: {
            serial: adbSerial,
            configId: activeConfigId,
            packageName: androidGamePackage,
            width: 1280,
            height: 720,
            density: 240,
          },
        });
        setAndroidVirtualDisplayActive(true);
        if (activeConfigId) await syncAndroidDeviceMethods(true);
        toast.success(`scrcpy virtual display #${report.displayId}`);
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
        setAndroidVirtualDisplayActive(false);
        if (activeConfigId) await syncAndroidDeviceMethods(false);
        toast.success("scrcpy virtual display closed");
      }
      void refreshAndroidVirtualDisplayStatus();
      return true;
    } catch (error) {
      toast.error(
        value ? "scrcpy virtual display failed" : "scrcpy virtual display cleanup failed",
        {
          description: String(error),
        }
      );
      void refreshAndroidVirtualDisplayStatus();
      return false;
    } finally {
      setAndroidVirtualDisplayBusy(false);
    }
  };

  useEffect(() => {
    void refreshAndroidVirtualDisplayStatus();
  }, [refreshAndroidVirtualDisplayStatus]);

  /**
   * Issues the scheduler start command for the active profile.
   * Guarded against duplicate submissions when a run is already active.
   */
  const startScript = async () => {
    if (!profile || !activeConfigId || scriptRunning || androidVirtualDisplayBusy) return;
    if (__WITH_ANDROID__) {
      // Mobile automation must stay off the physical display so the portrait UI remains usable.
      if (!scrcpyVirtualDisplayEnabled) {
        const prepared = await toggleAndroidVirtualDisplay(true);
        if (!prepared) return;
      } else {
        await syncAndroidDeviceMethods(true);
      }
    }
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
          toast.error("start_scheduler failed", {
            description: String((response as any)?.message ?? (response as any)?.error ?? ""),
          });
        }
      }
    );
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
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-5 text-foreground">
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
          {isAndroid && (
            <IconTooltip content={t("log")}>
              <button
                type="button"
                onClick={() => setAndroidLogOpen(true)}
                aria-label={t("log")}
                className={TOOL_BUTTON_CLASS}
              >
                <Logs className="h-4 w-4" strokeWidth={1.6} />
              </button>
            </IconTooltip>
          )}
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
          {isAndroid && (
            <button
              type="button"
              onClick={() => void toggleAndroidVirtualDisplay(!androidVirtualDisplayActive)}
              aria-label="切换虚拟屏"
              aria-pressed={androidVirtualDisplayActive}
              className={`${TOOL_BUTTON_CLASS} ${androidVirtualDisplayActive ? "bg-secondary text-foreground" : ""}`}
              disabled={androidVirtualDisplayBusy}
            >
              <Webcam className="h-4 w-4" strokeWidth={1.6} />
            </button>
          )}
          <CButton
            onClick={scriptRunning ? stopScript : startScript}
            aria-label={scriptRunning ? t("common.stop") : t("common.start")}
            variant={scriptRunning ? "danger" : "primary"}
            className="ml-2 h-[34px] gap-1.5 rounded-lg px-3.5 py-0 text-xs"
            disabled={androidVirtualDisplayBusy}
          >
            {scriptRunning ? (
              <Square className="h-3 w-3" fill="currentColor" strokeWidth={1.6} />
            ) : (
              <Play className="h-3.5 w-3.5" fill="currentColor" strokeWidth={1.6} />
            )}
            {androidVirtualDisplayBusy
              ? t("home.preparing")
              : scriptRunning
                ? t("common.stop")
                : t("common.start")}
          </CButton>
        </div>
      </div>

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

      {isAndroid && (
        <Card className="shrink-0 overflow-hidden p-0">
          <CardContent className="p-0">
            <div className="relative aspect-video w-full overflow-hidden bg-slate-950">
              {androidVirtualDisplayActive && activeConfigId ? (
                <AndroidVirtualDisplayPreview />
              ) : (
                <button
                  type="button"
                  onClick={() => void toggleAndroidVirtualDisplay(true)}
                  disabled={androidVirtualDisplayBusy}
                  className="flex h-full w-full flex-col items-center justify-center gap-3 text-slate-400 transition hover:bg-slate-900 hover:text-slate-200 disabled:cursor-wait"
                >
                  <Webcam className="h-9 w-9" />
                  <span className="text-sm">
                    {androidVirtualDisplayBusy ? "正在准备游戏画面…" : "点击启动虚拟屏"}
                  </span>
                </button>
              )}
              <div className="pointer-events-none absolute right-3 top-3 z-20 flex items-center gap-2 rounded-full bg-slate-900/75 px-3 py-1.5 text-xs font-medium text-white backdrop-blur-sm">
                <span
                  className={`h-2 w-2 rounded-full ${
                    scriptRunning ? "bg-emerald-400" : "bg-slate-400"
                  }`}
                />
                {scriptRunning ? "游戏运行中" : "游戏画面"}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Account data and task context share one compact summary area. */}
      {activeConfigId && (
        <div className="min-w-0 shrink-0 space-y-5">
          {assetsDisplay && <AssetsDisplay profileId={activeConfigId} />}
          <TaskStatus profileId={activeConfigId} />
        </div>
      )}

      {/* Logs form the main workspace; controls stay quiet until they are needed. */}
      {!isAndroid && (
        <section className="home-log-workspace home-log-surface flex min-h-64 min-w-0 flex-1 flex-col overflow-hidden rounded-[14px] bg-[var(--log-surface)] shadow-[var(--log-card-shadow)]">
          <div className="home-log-toolbar flex shrink-0 items-center justify-between gap-3 px-3 py-2.5">
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
                  onClick={() =>
                    setUiSettings((state) => ({ ...state, scrollToEnd: !scrollToEnd }))
                  }
                  aria-label={t("log.scroll")}
                  aria-pressed={scrollToEnd}
                  className={`flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${scrollToEnd ? "bg-secondary/70 text-foreground" : "text-muted-foreground"}`}
                >
                  <ArrowDownToLine className="h-3.5 w-3.5" strokeWidth={1.6} />
                  <span className="hidden sm:inline">{t("log.scroll")}</span>
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
          <div className="home-log-body relative flex min-h-0 min-w-0 flex-1 overflow-hidden pb-3 pt-1">
            {remoteAvailable && remoteVisible && activeConfigId && (
              <RemoteDisplay profileId={activeConfigId} />
            )}
            <Logger logs={activeLogs} scrollToEnd={scrollToEnd} />
          </div>
        </section>
      )}

      {isAndroid && (
        <Modal
          isOpen={androidLogOpen}
          onClose={() => setAndroidLogOpen(false)}
          title={t("log")}
          width={95}
        >
          <div className="mb-2 flex items-center justify-end gap-2">
            <SwitchButton
              checked={scrollToEnd}
              onChange={(value) => {
                setUiSettings((state) => ({ ...state, scrollToEnd: value }));
              }}
              label=""
              className="h-8 w-8"
              iconOnly
            >
              <ListEnd className="h-4 w-4" />
            </SwitchButton>
            <CButton onClick={exportLog} className="h-8 w-8" iconOnly>
              <FileDown className="h-4 w-4" />
            </CButton>
          </div>
          <div className="h-[65vh] min-h-72 overflow-hidden rounded-lg">
            <Logger logs={activeLogs} scrollToEnd={scrollToEnd} />
          </div>
        </Modal>
      )}
    </div>
  );
};

export default HomePage;

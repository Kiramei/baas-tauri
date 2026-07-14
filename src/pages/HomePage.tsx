import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApp } from "@/context/AppContext";
import CButton from "@/components/ui/CButton.tsx";
import Logger from "@/components/ui/Logger";
import AssetsDisplay from "@/components/AssetsDisplay";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { FileUp, Keyboard, ListEnd, Logs, Play, Square, Webcam } from "lucide-react";
import SwitchButton from "@/components/ui/SwitchButton.tsx";
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

const EMPTY_LOGS: LogItem[] = [];

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
  /** Handles the profile workflow. */
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

  const scrcpyVirtualDisplayEnabled = __WITH_ANDROID__ && androidVirtualDisplayActive;

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
          screenshot_method: "adb",
          control_method: "adb",
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
    const expectedMethod = useScrcpy ? "adb" : "android_local";
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

  const toggleAndroidVirtualDisplay = async (value: boolean) => {
    if (!__WITH_ANDROID__ || androidVirtualDisplayBusy) return;
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
    } catch (error) {
      toast.error(
        value ? "scrcpy virtual display failed" : "scrcpy virtual display cleanup failed",
        {
          description: String(error),
        }
      );
      void refreshAndroidVirtualDisplayStatus();
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
    if (__WITH_ANDROID__) await syncAndroidDeviceMethods(scrcpyVirtualDisplayEnabled);
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
  /** Handles the export log workflow. */
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
    <div className="h-full flex flex-col min-h-0 gap-2">
      {/* Header: high-level actions and script controls. */}
      <div className="flex justify-between items-center shrink-0">
        <div className="flex">
          <h2 className="text-2xl font-bold text-slate-800 dark:text-slate-100">{t("nav.home")}</h2>
          <h2 className="text-2xl ml-3 text-slate-500 dark:text-slate-400">#{profile?.name}</h2>
        </div>
        <div className="flex sm:hidden items-center gap-2">
          {remoteAvailable && (
            <SwitchButton
              checked={remoteVisible}
              onChange={(value) => {
                setRemoteVisible(value);
              }}
              label=""
              className="ml-2 h-8 w-8"
              iconOnly
            >
              <Webcam size={20} className="rounded w-4 h-4" />
            </SwitchButton>
          )}
          {hotkeyAvailable && (
            <CButton
              onClick={() => setHotkeyOpen(true)}
              variant="secondary"
              className="h-8 w-8"
              iconOnly
            >
              <Keyboard className="w-4 h-4" />
            </CButton>
          )}
          {isAndroid && (
            <SwitchButton
              checked={androidVirtualDisplayActive}
              onChange={toggleAndroidVirtualDisplay}
              label=""
              className="ml-2 h-8 w-8"
              disabled={androidVirtualDisplayBusy}
              iconOnly
            >
              <Webcam size={20} className="rounded w-4 h-4" />
            </SwitchButton>
          )}
          <CButton
            onClick={scriptRunning ? stopScript : startScript}
            variant={scriptRunning ? "danger" : "primary"}
            className="h-8 w-8"
            iconOnly
            disabled={androidVirtualDisplayBusy}
          >
            {scriptRunning ? <Square className="w-4 h-4" /> : <Play className="w-4 h-4" />}
          </CButton>
        </div>
        <div className="hidden sm:flex items-center gap-2">
          {remoteAvailable && (
            <SwitchButton
              checked={remoteVisible}
              onChange={(value) => {
                setRemoteVisible(value);
              }}
              label=""
              className="ml-2 h-8 w-8"
              iconOnly
            >
              <Webcam size={20} className="rounded w-4 h-4" />
            </SwitchButton>
          )}
          {hotkeyAvailable && (
            <CButton
              onClick={() => setHotkeyOpen(true)}
              variant="secondary"
              className="h-8 w-8"
              iconOnly
            >
              <Keyboard className="w-4 h-4" />
            </CButton>
          )}
          {isAndroid && (
            <SwitchButton
              checked={androidVirtualDisplayActive}
              onChange={toggleAndroidVirtualDisplay}
              label=""
              className="ml-2 h-8 w-8"
              disabled={androidVirtualDisplayBusy}
              iconOnly
            >
              <Webcam size={20} className="rounded w-4 h-4" />
            </SwitchButton>
          )}
          <CButton
            onClick={scriptRunning ? stopScript : startScript}
            variant={scriptRunning ? "danger" : "primary"}
            className="w-25 pl-3 flex items-center justify-center"
            disabled={androidVirtualDisplayBusy}
          >
            {scriptRunning ? (
              <Square className="w-4 h-4 mr-2" />
            ) : (
              <Play className="w-4 h-4 mr-2" />
            )}
            {androidVirtualDisplayBusy
              ? "准备中"
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

      {/* Live status for the active task pipeline. */}
      {activeConfigId && <TaskStatus profileId={activeConfigId} />}

      {/* Optional asset snapshot to provide immediate operational context. */}
      {assetsDisplay && (
        <div className="shrink-0">
          {activeConfigId && <AssetsDisplay profileId={activeConfigId} />}
        </div>
      )}

      {/* Streaming log viewer with scroll management and export tooling. */}
      <Card
        className={
          isAndroid
            ? "flex-1 min-h-0 flex flex-col overflow-hidden"
            : "flex-1 min-h-100 flex flex-col"
        }
      >
        <CardHeader className="flex justify-between items-center">
          <CardTitle>
            <div className="flex items-center gap-2">
              <Logs /> {t("log")}
            </div>
          </CardTitle>
          <div className="sm:flex hidden items-center justify-center">
            <SwitchButton
              checked={scrollToEnd}
              onChange={(value) => {
                setUiSettings((state) => ({ ...state, scrollToEnd: value }));
              }}
              label={t("log.scroll")}
              className="px-4!"
            />
            <CButton onClick={exportLog} className="ml-2">
              <div className="flex">
                <FileUp size={20} className="mr-2" />
                {t("log.export")}
              </div>
            </CButton>
          </div>

          <div className="sm:hidden flex items-center justify-center">
            <SwitchButton
              checked={scrollToEnd}
              onChange={(value) => {
                setUiSettings((state) => ({ ...state, scrollToEnd: value }));
              }}
              label=""
              className="ml-2 h-8 w-8"
              iconOnly
            >
              <ListEnd size={20} className="rounded w-4 h-4" />
            </SwitchButton>
            <CButton onClick={exportLog} className="ml-2 h-8 w-8" iconOnly>
              <FileUp size={20} className="rounded w-4 h-4" />
            </CButton>
          </div>
        </CardHeader>

        <CardContent className="relative flex-1 min-h-0 p-0 flex overflow-hidden">
          {remoteAvailable && remoteVisible && activeConfigId && (
            <RemoteDisplay profileId={activeConfigId} />
          )}
          <Logger logs={activeLogs} scrollToEnd={scrollToEnd} />
        </CardContent>
      </Card>
    </div>
  );
};

export default HomePage;

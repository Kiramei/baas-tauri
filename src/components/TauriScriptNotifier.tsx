import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@/shared/TauriInvoke";

import { useUISetting } from "@/context/UISettingsProvider";
import { eventNameKey } from "@/shared/I18nKeys";
import { useWebSocketStore } from "@/store/WebsocketStore";

type ScriptStatus = {
  running?: boolean;
  config_id?: string | null;
  current_task?: string | null;
  waiting_tasks?: string[];
  exit_code?: number | string | null;
  run_mode?: "scheduler" | "single" | null;
};

type StatusSnapshot = {
  running: boolean;
  currentTask: string | null;
  lastTask: string | null;
  exitCode: number | string | null;
  runMode: "scheduler" | "single" | null;
};

/** Treats any non-zero numeric exit code or opaque non-empty exit marker as a failure. */
const isFailureExitCode = (exitCode: number | string | null | undefined) => {
  if (exitCode === null || exitCode === undefined || exitCode === "") return false;
  const numeric = Number(exitCode);
  return Number.isFinite(numeric) ? numeric !== 0 : true;
};

/** Emits native system notifications for Tauri-only script lifecycle events. */
const TauriScriptNotifier: React.FC = () => {
  const { t } = useTranslation();
  const notificationsEnabled = useUISetting((settings) => settings.enableSystemNotifications);
  const statusStore = useWebSocketStore((state) => state.statusStore);
  const previousRef = useRef<Record<string, StatusSnapshot>>({});
  const initializedRef = useRef(false);

  useEffect(() => {
    if (!__WITH_TAURI__) return;

    const nextSnapshots: Record<string, StatusSnapshot> = {};
    const notify = notificationsEnabled
      ? (title: string, body: string, tag: string) => {
          void invoke("baas_notify", {
            payload: { title, body, tag },
          }).catch((error) => {
            console.warn("[notifier] failed to send system notification", error);
          });
        }
      : () => {};

    for (const [configId, status] of Object.entries(statusStore as Record<string, ScriptStatus>)) {
      const previous = previousRef.current[configId];
      const currentTask = status.current_task ?? null;
      const next: StatusSnapshot = {
        running: Boolean(status.running),
        currentTask,
        lastTask: currentTask ?? previous?.lastTask ?? null,
        exitCode: status.exit_code ?? null,
        runMode: status.run_mode ?? null,
      };
      nextSnapshots[configId] = next;

      if (!initializedRef.current || !previous) {
        continue;
      }

      const schedulerMode = next.runMode === "scheduler";
      const runStarted = !previous.running && next.running;
      const runStopped = previous.running && !next.running;
      const completedTask = previous.currentTask && !currentTask ? previous.currentTask : null;
      const schedulerCompleted = Boolean(
        schedulerMode &&
        next.running &&
        previous.currentTask &&
        !currentTask &&
        (status.waiting_tasks?.length ?? 0) === 0
      );
      const failed = previous.running && !next.running && isFailureExitCode(next.exitCode);
      const stoppedTask = schedulerMode
        ? t("nav.scheduler")
        : (previous.currentTask ?? previous.lastTask);

      if (failed && stoppedTask) {
        const task = schedulerMode ? stoppedTask : t(eventNameKey(stoppedTask));
        notify(
          t("notification.script.failedTitle"),
          t("notification.script.failedBody", { task, exitCode: next.exitCode }),
          `script:${configId}:failed:${stoppedTask}:${next.exitCode}`
        );
      } else if (schedulerCompleted || (!schedulerMode && runStopped && completedTask)) {
        const task = schedulerMode ? t("nav.scheduler") : t(eventNameKey(completedTask as string));
        notify(
          t("notification.script.completedTitle"),
          t("notification.script.completedBody", { task }),
          `script:${configId}:completed:${schedulerMode ? "scheduler" : completedTask}`
        );
      }

      const startedTask = schedulerMode
        ? runStarted
          ? t("nav.scheduler")
          : null
        : currentTask && currentTask !== previous.currentTask
          ? t(eventNameKey(currentTask))
          : null;
      if (startedTask) {
        notify(
          t("notification.script.startedTitle"),
          t("notification.script.startedBody", { task: startedTask }),
          `script:${configId}:started:${schedulerMode ? "scheduler" : currentTask}`
        );
      }
    }

    previousRef.current = nextSnapshots;
    initializedRef.current = true;
  }, [notificationsEnabled, statusStore, t]);

  return null;
};

export default TauriScriptNotifier;

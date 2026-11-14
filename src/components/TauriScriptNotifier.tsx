import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useUISetting } from "@/context/UISettingsProvider";
import { eventNameKey } from "@/shared/I18nKeys";
import { useWebSocketStore } from "@/store/WebsocketStore";
import { ScriptNotificationTracker } from "@/components/tauriScriptNotifierState";
import { subscribeScriptStatus } from "@/shared/ScriptStatusEvents";
import { createSystemNotificationDelivery } from "@/shared/SystemNotificationDelivery";

/** Snapshots seed the observer; only new provider events may notify in the background. */
const TauriScriptNotifier: React.FC = () => {
  const { t } = useTranslation();
  const notificationsEnabled = useUISetting((settings) => settings.enableSystemNotifications);
  const enabled = useRef(notificationsEnabled);
  const translate = useRef(t);
  useEffect(() => {
    enabled.current = notificationsEnabled;
    translate.current = t;
  }, [notificationsEnabled, t]);

  useEffect(() => {
    if (!__WITH_TAURI__) return;
    const tracker = new ScriptNotificationTracker();
    const dispatcher = createSystemNotificationDelivery(
      () => enabled.current,
      (latest, count) => {
        const t = translate.current;
        return t("notification.script.batchBody", { latest, count });
      }
    );
    const unsubscribe = subscribeScriptStatus((delivery) => {
      const t = translate.current;
      if (delivery.kind === "reset") dispatcher.clear();
      for (const event of tracker.accept(delivery)) {
        const task = event.scheduler
          ? t("nav.scheduler")
          : event.task
            ? t(eventNameKey(event.task))
            : (useWebSocketStore.getState().configStore[event.configId]?.name ?? event.configId);
        const title =
          event.kind === "failed"
            ? t("notification.script.failedTitle")
            : event.kind === "completed"
              ? t("notification.script.completedTitle")
              : t("notification.script.startedTitle");
        const body =
          event.kind === "failed"
            ? t("notification.script.failedBody", { task, exitCode: event.exitCode })
            : event.kind === "completed"
              ? t("notification.script.completedBody", { task })
              : t("notification.script.startedBody", { task });
        void dispatcher.enqueue({
          key: event.key,
          group: `script:${event.kind}`,
          runKey: event.key.slice(0, event.key.lastIndexOf(":")),
          terminal: event.kind !== "started",
          payload: { title, body, tag: event.tag },
        });
      }
    });
    return () => {
      unsubscribe();
      dispatcher.clear();
    };
  }, []);

  return null;
};

export default TauriScriptNotifier;

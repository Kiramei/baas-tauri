import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useUISetting } from "@/context/UISettingsProvider";
import {
  SERVICE_TRANSPORT_DISCONNECTED_EVENT,
  type ServiceTransportDisconnectedDetail,
} from "@/shared/ServiceTransportEvents";
import { createSystemNotificationDelivery } from "@/shared/SystemNotificationDelivery";

/** Emits native notifications for backend transport outages on every Tauri platform. */
const TauriServiceNotifier: React.FC = () => {
  const { t } = useTranslation();
  const notificationsEnabled = useUISetting((settings) => settings.enableSystemNotifications);

  useEffect(() => {
    if (!__WITH_TAURI__) return;
    const dispatcher = createSystemNotificationDelivery(
      () => notificationsEnabled,
      (latest) => latest
    );
    const onDisconnected = (event: Event) => {
      if (!notificationsEnabled) return;
      const { mode } = (event as CustomEvent<ServiceTransportDisconnectedDetail>).detail;
      const transport =
        mode === "shm"
          ? t("transport.shm")
          : mode === "pipe"
            ? t("transport.pipe")
            : t("transport.websocket");
      void dispatcher.enqueue({
        key: `service:disconnected:${mode}`,
        group: `service:disconnected:${mode}`,
        cooldownMs: 30_000,
        payload: {
          title: t("notification.service.disconnectedTitle"),
          body: t("notification.service.disconnectedBody", { transport }),
          tag: `service:disconnected:${mode}`,
        },
      });
    };
    window.addEventListener(SERVICE_TRANSPORT_DISCONNECTED_EVENT, onDisconnected);
    return () => {
      window.removeEventListener(SERVICE_TRANSPORT_DISCONNECTED_EVENT, onDisconnected);
      dispatcher.clear();
    };
  }, [notificationsEnabled, t]);

  return null;
};

export default TauriServiceNotifier;

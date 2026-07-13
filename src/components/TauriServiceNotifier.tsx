import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useUISetting } from "@/context/UISettingsProvider";
import {
  SERVICE_TRANSPORT_DISCONNECTED_EVENT,
  type ServiceTransportDisconnectedDetail,
} from "@/shared/ServiceTransportEvents";
import { invoke } from "@/shared/TauriInvoke";

/** Emits native notifications for backend transport outages on every Tauri platform. */
const TauriServiceNotifier: React.FC = () => {
  const { t } = useTranslation();
  const notificationsEnabled = useUISetting((settings) => settings.enableSystemNotifications);

  useEffect(() => {
    if (!__WITH_TAURI__) return;
    const onDisconnected = (event: Event) => {
      if (!notificationsEnabled) return;
      const { mode } = (event as CustomEvent<ServiceTransportDisconnectedDetail>).detail;
      const transport = mode === "pipe" ? t("transport.pipe") : t("transport.websocket");
      void invoke("baas_notify", {
        payload: {
          title: t("notification.service.disconnectedTitle"),
          body: t("notification.service.disconnectedBody", { transport }),
          tag: `service:disconnected:${mode}`,
        },
      }).catch((error) => {
        console.warn("[notifier] failed to send service notification", error);
      });
    };
    window.addEventListener(SERVICE_TRANSPORT_DISCONNECTED_EVENT, onDisconnected);
    return () => window.removeEventListener(SERVICE_TRANSPORT_DISCONNECTED_EVENT, onDisconnected);
  }, [notificationsEnabled, t]);

  return null;
};

export default TauriServiceNotifier;

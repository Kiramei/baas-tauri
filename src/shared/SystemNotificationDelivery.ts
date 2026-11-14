import { invoke } from "@/shared/TauriInvoke";
import { SystemNotificationDispatcher } from "@/shared/SystemNotificationPolicy";

/** Native focus also covers an active WebView whose DOM temporarily lost focus. */
export async function isApplicationBackground(): Promise<boolean> {
  if (typeof document === "undefined") return false;
  if (__WITH_ANDROID__) return document.visibilityState === "hidden";
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return !(await getCurrentWindow().isFocused());
  } catch {
    // Unknown native focus must not produce a startup notification storm.
    return false;
  }
}

export function createSystemNotificationDelivery(
  enabled: () => boolean,
  summarize: (latest: string, count: number) => string
): SystemNotificationDispatcher {
  return new SystemNotificationDispatcher({
    enabled,
    summarize,
    isBackground: isApplicationBackground,
    send: (payload) => invoke("baas_notify", { payload }),
  });
}

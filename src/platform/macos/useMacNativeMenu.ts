import { useEffect, useState } from "react";
import { mountMacNativeMenu, type MacMenuModel } from "./NativeMenu";

/** Keep a browser fallback until installing the system menu succeeds. */
export function useMacNativeMenu(enabled: boolean, model: MacMenuModel): boolean {
  const [installed, setInstalled] = useState(false);
  const [session, setSession] = useState<ReturnType<typeof mountMacNativeMenu>>();
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    const menu = mountMacNativeMenu(model);
    setSession(menu);
    void menu.ready
      .then((ready) => {
        if (!disposed) setInstalled(ready);
      })
      .catch((error: unknown) => console.error("[mac-menu] installation failed", error));
    return () => {
      disposed = true;
      setInstalled(false);
      setSession(undefined);
      void menu
        .dispose()
        .catch((error: unknown) => console.error("[mac-menu] cleanup failed", error));
    };
  }, [enabled]);
  useEffect(() => {
    if (session)
      void session
        .update(model)
        .catch((error: unknown) => console.error("[mac-menu] update failed", error));
  }, [session, model]);
  return enabled && installed;
}

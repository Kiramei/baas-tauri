import { useEffect } from "react";
import { invoke } from "@/shared/TauriInvoke";

/** Keep Android's status and gesture bars on the same surface as the app. */
export function useAndroidSystemBars() {
  useEffect(() => {
    if (!__WITH_ANDROID__ || !__WITH_TAURI__) return;
    const root = document.documentElement;
    let lastTheme = "";
    const synchronize = () => {
      const dark = root.classList.contains("dark");
      const surface = getComputedStyle(root).getPropertyValue("--background").trim();
      const backgroundColor = /^#[\da-f]{6}$/i.test(surface)
        ? surface
        : dark
          ? "#181818"
          : "#ffffff";
      const theme = `${backgroundColor}:${dark}`;
      if (theme === lastTheme) return;
      lastTheme = theme;
      void invoke("android_set_system_bars", { backgroundColor, darkIcons: !dark }).catch(
        (error) => {
          if (lastTheme === theme) lastTheme = "";
          console.warn("Android system bar theme update failed", error);
        }
      );
    };
    const observer = new MutationObserver(synchronize);
    observer.observe(root, { attributes: true, attributeFilter: ["class", "style"] });
    window.addEventListener("focus", synchronize);
    synchronize();
    return () => {
      observer.disconnect();
      window.removeEventListener("focus", synchronize);
    };
  }, []);
}

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useWindowLayout } from "@/context/WindowLayoutProvider";
import { useNavigationHistory } from "@/context/NavigationHistoryProvider";
import { useSetUISettings, useUISetting } from "@/context/UISettingsProvider";
import type { HotkeyConfig } from "@/components/HotkeyConfig";
import StorageUtil from "@/shared/StorageManager";
import { useAppTranslation } from "@/shared/useAppTranslation";
import { createNativeFullscreenController } from "@/shared/NativeFullscreen";
import {
  canToggleWorkspaceSidebar,
  MAX_WORKSPACE_ZOOM,
  MIN_WORKSPACE_ZOOM,
  normalizeWorkspaceZoom,
  stepWorkspaceZoom,
} from "@/shared/ViewActions";
import { useApplicationShortcuts } from "@/shared/useApplicationShortcuts";
import {
  applicationShortcutMatches,
  normalizeApplicationShortcut,
} from "@/shared/ApplicationShortcuts";

/** One menu owner mounts this hook, keeping keyboard handlers and window listeners unique. */
export function useViewActions() {
  const { t } = useAppTranslation();
  const applicationShortcuts = useApplicationShortcuts();
  const layout = useWindowLayout();
  const { fullscreen, setFullscreen } = layout;
  const navigation = useNavigationHistory();
  const storedZoom = useUISetting((settings) => settings.zoomScale);
  const setUiSettings = useSetUISettings();
  const zoomScale = normalizeWorkspaceZoom(storedZoom);
  const [desktop, setDesktop] = useState(() => window.matchMedia("(min-width: 64rem)").matches);
  const [fullscreenBusy, setFullscreenBusy] = useState(false);
  const busy = useRef(false);
  const [nativeFullscreenController] = useState(createNativeFullscreenController);
  const mounted = useRef(true);
  const nativeFullscreen = __WITH_TAURI__ && !__WITH_ANDROID__;
  const canFullscreen =
    !__WITH_ANDROID__ &&
    (nativeFullscreen ||
      (document.fullscreenEnabled === true &&
        typeof document.documentElement.requestFullscreen === "function"));
  const canToggleSidebar = canToggleWorkspaceSidebar(
    layout.available,
    desktop,
    layout.sidebarLocked
  );

  useEffect(() => {
    mounted.current = true;
    const media = window.matchMedia("(min-width: 64rem)");
    const update = () => setDesktop(media.matches);
    media.addEventListener("change", update);
    return () => {
      mounted.current = false;
      media.removeEventListener("change", update);
    };
  }, []);

  useEffect(() => {
    if (!nativeFullscreen) {
      const update = () => setFullscreen(Boolean(document.fullscreenElement));
      update();
      document.addEventListener("fullscreenchange", update);
      return () => document.removeEventListener("fullscreenchange", update);
    }
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/window")
      .then(async ({ getCurrentWindow }) => {
        if (disposed) return;
        const appWindow = getCurrentWindow();
        const update = () => {
          void appWindow
            .isFullscreen()
            .then((value) => {
              if (!disposed) setFullscreen(value);
            })
            .catch(console.warn);
        };
        update();
        const cleanup = await appWindow.onResized(update);
        if (disposed) cleanup();
        else unlisten = cleanup;
      })
      .catch(console.warn);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [nativeFullscreen, setFullscreen]);

  const toggleSidebar = useCallback(() => {
    if (canToggleSidebar) layout.setExpanded(!layout.expanded);
  }, [canToggleSidebar, layout.expanded, layout.setExpanded]);
  const zoomIn = useCallback(
    () =>
      setUiSettings((settings) => ({
        ...settings,
        zoomScale: stepWorkspaceZoom(settings.zoomScale, 1),
      })),
    [setUiSettings]
  );
  const zoomOut = useCallback(
    () =>
      setUiSettings((settings) => ({
        ...settings,
        zoomScale: stepWorkspaceZoom(settings.zoomScale, -1),
      })),
    [setUiSettings]
  );
  const resetZoom = useCallback(
    () => setUiSettings((settings) => ({ ...settings, zoomScale: 100 })),
    [setUiSettings]
  );
  const toggleFullscreen = useCallback(() => {
    if (!canFullscreen || busy.current) return;
    busy.current = true;
    setFullscreenBusy(true);
    void (async () => {
      if (nativeFullscreen) {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const appWindow = getCurrentWindow();
        const value = await nativeFullscreenController.toggle(appWindow);
        if (mounted.current) setFullscreen(value);
      } else if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        // Start within the original click/key gesture to retain browser activation.
        await document.documentElement.requestFullscreen();
      }
    })()
      .catch((error: unknown) => {
        console.error("[view] fullscreen failed", error);
        toast.error(t("view.fullscreenFailed"));
      })
      .finally(() => {
        busy.current = false;
        if (mounted.current) setFullscreenBusy(false);
      });
  }, [canFullscreen, nativeFullscreen, nativeFullscreenController, setFullscreen, t]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || __WITH_ANDROID__ || !layout.available)
        return;
      if (
        event.target instanceof Element &&
        event.target.closest(
          "input,textarea,select,[contenteditable]:not([contenteditable='false']),[role='textbox'],[role='menu'],[role='listbox']"
        )
      )
        return;
      if (document.querySelector("[aria-modal='true']")) return;
      const mac = /Mac|iPhone|iPad/.test(navigator.platform || "");
      const action = (["sidebar", "zoomIn", "zoomOut", "resetZoom", "fullscreen"] as const).find(
        (id) => applicationShortcutMatches(event, id, applicationShortcuts.bindings, mac)
      );
      if (
        !action ||
        (action === "sidebar" && !canToggleSidebar) ||
        (action === "fullscreen" && !canFullscreen)
      )
        return;
      // The titlebar is outside TauriShortcutProvider; consult fresh persisted bindings instead.
      let bindings: HotkeyConfig[];
      try {
        const saved = StorageUtil.get<HotkeyConfig[]>("hotkeys");
        bindings = Array.isArray(saved) ? saved : [];
      } catch {
        return;
      } // Setup has not initialized durable storage yet.
      if (
        bindings.some(
          (binding) =>
            binding.enabled !== false &&
            binding.value &&
            normalizeApplicationShortcut(binding.value, mac) ===
              normalizeApplicationShortcut(applicationShortcuts.bindings[action], mac)
        )
      )
        return;
      event.preventDefault();
      if (event.repeat && action !== "zoomIn" && action !== "zoomOut") return;
      ({ sidebar: toggleSidebar, zoomIn, zoomOut, resetZoom, fullscreen: toggleFullscreen })[
        action
      ]();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    applicationShortcuts.bindings,
    canFullscreen,
    canToggleSidebar,
    layout.available,
    resetZoom,
    toggleFullscreen,
    toggleSidebar,
    zoomIn,
    zoomOut,
  ]);

  return {
    toggleSidebar,
    canToggleSidebar,
    sidebarExpanded: layout.expanded,
    back: navigation.back,
    canBack: navigation.canBack,
    forward: navigation.forward,
    canForward: navigation.canForward,
    zoomIn,
    zoomOut,
    resetZoom,
    zoomScale,
    canZoomIn: zoomScale < MAX_WORKSPACE_ZOOM,
    canZoomOut: zoomScale > MIN_WORKSPACE_ZOOM,
    toggleFullscreen,
    fullscreen,
    canFullscreen,
    fullscreenBusy,
  };
}

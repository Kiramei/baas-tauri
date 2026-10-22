import { IconTooltip } from "@/components/ui/Tooltip";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { ArrowLeftIcon } from "@phosphor-icons/react/dist/csr/ArrowLeft";
import { ArrowRightIcon } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { SidebarSimpleIcon } from "@phosphor-icons/react/dist/csr/SidebarSimple";
import { useTheme } from "@/context/ThemeProvider";
import { useWindowLayout } from "@/context/WindowLayoutProvider";
import { useNavigationHistory } from "@/context/NavigationHistoryProvider";
import TitlebarMenus from "@/components/layout/TitlebarMenus";
import { useNativeWindowControls } from "@/shared/useNativeWindowControls";

const macOS = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

/** Shared desktop toolbar, with native traffic lights retained on macOS. */
export default function WindowTitlebar() {
  const { t } = useTranslation();
  const { theme } = useTheme();
  const {
    expanded,
    available,
    sidebarLocked,
    customFrame,
    fullscreen,
    setExpanded,
    setCustomFrame,
    setFullscreen,
  } = useWindowLayout();
  const navigation = useNavigationHistory();
  const nativeControls = useNativeWindowControls();
  const titlebarHeight = Math.max(44, nativeControls.height);
  const [maximized, setMaximized] = useState(false);
  const [focused, setFocused] = useState(true);
  const dragRegionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!__WITH_TAURI__ || __WITH_ANDROID__) return;

    const appWindow = getCurrentWindow();
    const unlisteners: UnlistenFn[] = [];
    let disposed = false;
    const reportError = (error: unknown) => console.warn("[window] title bar update failed", error);
    const register = (listener: Promise<UnlistenFn>) => {
      void listener.then((unlisten) => {
        if (disposed) unlisten();
        else unlisteners.push(unlisten);
      }, reportError);
    };
    const syncMaximized = () => {
      void Promise.all([appWindow.isMaximized(), appWindow.isFullscreen()]).then(
        ([value, isFullscreen]) => {
          if (!disposed) {
            setMaximized(value);
            setFullscreen(isFullscreen);
          }
        },
        reportError
      );
    };

    void Promise.all([
      appWindow.isDecorated(),
      appWindow.isMaximized(),
      appWindow.isFullscreen(),
      appWindow.isFocused(),
    ]).then(([decorated, isMaximized, isFullscreen, isFocused]) => {
      if (disposed) return;
      setCustomFrame(!decorated || macOS);
      setMaximized(isMaximized);
      setFullscreen(isFullscreen);
      setFocused(isFocused);
    }, reportError);

    register(appWindow.onResized(syncMaximized));
    register(
      appWindow.onFocusChanged(({ payload }) => {
        if (!disposed) setFocused(payload);
      })
    );

    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
      setCustomFrame(false);
    };
  }, [setCustomFrame, setFullscreen]);

  useLayoutEffect(() => {
    if (!__WITH_TAURI__ || __WITH_ANDROID__ || !customFrame) return;

    const rootStyle = document.documentElement.style;
    const property = "--window-titlebar-height";
    const previousValue = rootStyle.getPropertyValue(property);
    const previousPriority = rootStyle.getPropertyPriority(property);
    // Body portals need the same workspace boundary as the App flex layout.
    rootStyle.setProperty(property, `${titlebarHeight}px`);
    const windowsMaterial = navigator.userAgent.includes("Windows");
    if (windowsMaterial) document.documentElement.dataset.windowMaterial = "acrylic";
    return () => {
      if (previousValue) rootStyle.setProperty(property, previousValue, previousPriority);
      else rootStyle.removeProperty(property);
      if (windowsMaterial) delete document.documentElement.dataset.windowMaterial;
    };
  }, [customFrame, titlebarHeight]);

  useEffect(() => {
    if (!__WITH_TAURI__ || __WITH_ANDROID__ || !customFrame) return;
    // Native backdrop and window controls follow the user's in-app appearance.
    void getCurrentWindow()
      .setTheme(theme === "system" ? null : theme)
      .catch(console.warn);
  }, [customFrame, theme]);

  useEffect(() => {
    if (!__WITH_TAURI__ || __WITH_ANDROID__ || !customFrame || fullscreen) return;

    const appWindow = getCurrentWindow();
    const dragThroughBackdrop = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        !(event.target instanceof Element) ||
        !event.target.matches("[data-modal-backdrop]")
      )
        return;
      const bounds = dragRegionRef.current?.getBoundingClientRect();
      if (
        !bounds ||
        event.clientX < bounds.left ||
        event.clientX >= bounds.right ||
        event.clientY < bounds.top ||
        event.clientY >= bounds.bottom
      )
        return;

      // Keep the modal's dimming and input barrier. Only its backdrop over the
      // existing blank titlebar region forwards this gesture to the native frame.
      event.preventDefault();
      event.stopPropagation();
      void appWindow
        .startDragging()
        .catch((error: unknown) => console.warn("[window] modal drag failed", error));
    };
    document.addEventListener("mousedown", dragThroughBackdrop, true);
    return () => document.removeEventListener("mousedown", dragThroughBackdrop, true);
  }, [customFrame, fullscreen]);

  if (!__WITH_TAURI__ || __WITH_ANDROID__ || !customFrame) return null;

  const runWindowAction = (action: "minimize" | "toggleMaximize" | "close") => {
    // close() sends CloseRequested, preserving the existing system-tray behavior.
    void getCurrentWindow()
      [action]()
      .catch((error: unknown) => {
        console.error(`[window] ${action} failed`, error);
      });
  };
  // Keep caption controls at Windows' proportions, independently of the app's
  // navigation buttons. Filled glyphs avoid softened half-pixel SVG strokes.
  const controlClass =
    "inline-flex h-[35px] w-[46px] shrink-0 items-center justify-center rounded-none text-[var(--foreground)] outline-none transition-colors duration-100";
  const neutralControlClass = `${controlClass} hover:bg-[var(--sidebar-accent)] focus-visible:bg-[var(--sidebar-accent)]`;
  const navigationControlClass =
    "flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-30";

  return (
    <header
      className="relative z-[1000] flex h-8 w-full shrink-0 select-none items-start pb-2 pt-1 text-[var(--foreground)]"
      style={{ boxSizing: "content-box", height: titlebarHeight - 12 }}
      aria-label={t("app.windowControls")}
      data-window-titlebar=""
      data-focused={focused}
      data-platform={macOS ? "macos" : "other"}
    >
      {macOS && !fullscreen && (
        <div className="h-8 w-20 shrink-0" aria-hidden="true" data-native-traffic-lights="" />
      )}
      {nativeControls.available && nativeControls.startWidth > 0 && (
        <div
          className="h-8 shrink-0"
          style={{ width: nativeControls.startWidth }}
          data-native-window-controls="start"
          aria-hidden="true"
        />
      )}
      <div className="flex h-8 shrink-0 items-center gap-0.5 px-2">
        <IconTooltip content={t("app.back")} side="bottom">
          <button
            type="button"
            aria-label={t("app.back")}
            aria-keyshortcuts="Alt+ArrowLeft"
            disabled={!navigation.canBack}
            onClick={navigation.back}
            className={navigationControlClass}
          >
            <ArrowLeftIcon size={18} weight="regular" aria-hidden="true" />
          </button>
        </IconTooltip>
        <IconTooltip content={t("app.forward")} side="bottom">
          <button
            type="button"
            aria-label={t("app.forward")}
            aria-keyshortcuts="Alt+ArrowRight"
            disabled={!navigation.canForward}
            onClick={navigation.forward}
            className={navigationControlClass}
          >
            <ArrowRightIcon size={18} weight="regular" aria-hidden="true" />
          </button>
        </IconTooltip>
        {available && !sidebarLocked && (
          <IconTooltip
            content={expanded ? t("app.collapseSidebar") : t("app.expandSidebar")}
            side="bottom"
          >
            <button
              type="button"
              aria-label={expanded ? t("app.collapseSidebar") : t("app.expandSidebar")}
              aria-expanded={expanded}
              onClick={() => setExpanded(!expanded)}
              className={`${navigationControlClass} hidden lg:flex`}
            >
              <SidebarSimpleIcon size={18} weight="regular" aria-hidden="true" />
            </button>
          </IconTooltip>
        )}
        <TitlebarMenus />
      </div>
      {/* Removing the native region also disables double-click maximize in fullscreen. */}
      <div
        ref={dragRegionRef}
        data-tauri-drag-region={fullscreen ? undefined : ""}
        className="h-8 min-w-0 flex-1"
      />
      {!fullscreen && nativeControls.available && (
        <div
          className="h-8 shrink-0"
          style={{ width: nativeControls.endWidth }}
          data-native-window-controls="end"
          aria-hidden="true"
        />
      )}
      {!fullscreen && !macOS && !nativeControls.available && (
        <div className="-mt-1 flex h-[35px] shrink-0 items-stretch" data-window-caption-controls="">
          <IconTooltip content={t("app.minimize")} side="bottom">
            <button
              type="button"
              className={neutralControlClass}
              aria-label={t("app.minimize")}
              onClick={() => runWindowAction("minimize")}
            >
              <svg
                aria-hidden="true"
                width="10"
                height="10"
                viewBox="0 0 10 10"
                fill="currentColor"
                shapeRendering="crispEdges"
              >
                <path d="M0 5h10v1H0z" />
              </svg>
            </button>
          </IconTooltip>
          <IconTooltip content={maximized ? t("app.restore") : t("app.maximize")} side="bottom">
            <button
              type="button"
              className={neutralControlClass}
              aria-label={maximized ? t("app.restore") : t("app.maximize")}
              onClick={() => runWindowAction("toggleMaximize")}
            >
              <svg
                aria-hidden="true"
                width="10"
                height="10"
                viewBox="0 0 10 10"
                fill="currentColor"
                shapeRendering="crispEdges"
              >
                {maximized ? (
                  <path
                    d="M2 0h8v8H8v2H0V2h2V0Zm1 2h5v5h1V1H3v1ZM1 3v6h6V3H1Z"
                    fillRule="evenodd"
                  />
                ) : (
                  <path d="M0 0h10v10H0V0Zm1 1v8h8V1H1Z" fillRule="evenodd" />
                )}
              </svg>
            </button>
          </IconTooltip>
          <IconTooltip content={t("app.close")} side="bottom">
            <button
              type="button"
              className={`${controlClass} hover:bg-[#c42b1c] hover:text-white focus-visible:bg-[#c42b1c] focus-visible:text-white`}
              aria-label={t("app.close")}
              onClick={() => runWindowAction("close")}
            >
              <svg
                aria-hidden="true"
                width="10"
                height="10"
                viewBox="0 0 10 10"
                fill="currentColor"
              >
                <path d="M.707 0 5 4.293 9.293 0 10 .707 5.707 5 10 9.293 9.293 10 5 5.707.707 10 0 9.293 4.293 5 0 .707Z" />
              </svg>
            </button>
          </IconTooltip>
        </div>
      )}
    </header>
  );
}

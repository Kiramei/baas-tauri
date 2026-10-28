import React, { Suspense, useCallback, useEffect, useLayoutEffect, useState } from "react";
import { AppProvider, useApp } from "@/context/AppContext";
import { ThemeProvider } from "@/context/ThemeProvider";
import { PageKey } from "@/types/app";
import i18n from "@/shared/I18nTranslator.ts";
import { UISettingsProvider, useUISetting } from "@/context/UISettingsProvider.tsx";
import LoadingPage from "@/pages/LoadingPage";
import StartupShellHandoff from "@/components/StartupShellHandoff";
import { androidBackDestination, mobileNavigationPage, normalizePageKey } from "@/shared/PageKey";
import { PLUGIN_OPEN_EVENT } from "@/shared/Plugins";
import { useConfigurationWorkspace } from "@/shared/useConfigurationWorkspace";
import { AboutBaasProvider } from "@/context/AboutBaasProvider";
import { ProfileActionsProvider } from "@/context/ProfileActionsProvider";
import PageActivity from "@/components/PageActivity";
import "./mobile.css";
import { useAndroidSystemBars } from "./useAndroidSystemBars";

declare global {
  interface Window {
    __BAAS_ANDROID_HANDLE_BACK__?: () => boolean;
  }
}

const ignoreReady = () => {};

const BAComet = React.lazy(() => import("@/components/ui/BAComet.tsx"));
const ConfigArchiveDropOverlay = React.lazy(() => import("@/components/ConfigArchiveDropOverlay"));
const GlobalAppearanceEffects = React.lazy(() => import("@/components/GlobalAppearanceEffects"));
const GlobalContextMenu = React.lazy(() => import("@/components/GlobalContextMenu"));
const ReconnectingOverlay = React.lazy(() => import("@/components/ReconnectingOverlay.tsx"));
const TauriScriptNotifier = React.lazy(() => import("@/components/TauriScriptNotifier"));
const TauriServiceNotifier = React.lazy(() => import("@/components/TauriServiceNotifier"));
const TauriSelfUpdateProvider = React.lazy(() =>
  import("@/context/TauriSelfUpdateProvider").then((module) => ({
    default: module.TauriSelfUpdateProvider,
  }))
);
const TauriShortcutProvider = React.lazy(() =>
  import("@/context/TauriShortcutProvider.tsx").then((module) => ({
    default: module.TauriShortcutProvider,
  }))
);
const Toaster = React.lazy(() =>
  import("@/components/ui/Sonner").then((module) => ({ default: module.Toaster }))
);

const loadHomePage = () => import("@/pages/HomePage");
const loadMainLayout = () => import("@/components/layout/MainLayout");
const HomePage = React.lazy(loadHomePage);
const MainLayout = React.lazy(loadMainLayout);
const SchedulerPage = React.lazy(() => import("@/pages/SchedulerPage"));
const ConfigurationPage = React.lazy(() => import("@/android/pages/ConfigurationPage"));
const SettingsPage = React.lazy(() => import("@/android/pages/SettingsPage"));
let homeReadyReported = false;
const HomeReadyMarker: React.FC<{ onReady: () => void }> = ({ onReady }) => {
  useEffect(() => {
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (!homeReadyReported) {
          homeReadyReported = true;
          console.info(`__ANDROID_HOME_READY__ ${performance.now().toFixed(0)}ms`);
        }
        onReady();
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [onReady]);
  return null;
};

/**
 * Builds a stable key so each profile-specific page instance can preserve its internal state.
 */
const instanceKeyOf = (page: PageKey, pid?: string) =>
  page === "home" || page === "scheduler" || page === "configuration"
    ? `${page}:${pid ?? "none"}`
    : page;

/** Renders a lightweight in-page loading surface while route chunks are fetched. */
const PageLoadingFallback: React.FC = () => (
  <div className="flex h-full min-h-60 items-center justify-center">
    <div className="h-8 w-8 rounded-full border-2 border-slate-300 border-t-primary-500 animate-spin" />
  </div>
);

/** Preserve each profile's pages and pause inactive editors in the same render. */
export const Main: React.FC<{ onReady?: () => void }> = ({ onReady = ignoreReady }) => {
  const [selectedPage, setActivePage] = React.useState<PageKey>("home");
  const requestedPage = normalizePageKey(selectedPage);
  const activePage = mobileNavigationPage(requestedPage, "android");
  const { activeProfile, profiles } = useApp();
  const activePid = activeProfile?.id;
  const configuration = useConfigurationWorkspace(activePid, "android");
  useEffect(() => {
    const openPlugins = () => {
      if (!activePid) {
        setActivePage("home");
        return;
      }
      configuration.search("");
      configuration.select("plugins");
      setActivePage("configuration");
    };
    if (requestedPage === "plugins") openPlugins();
    window.addEventListener(PLUGIN_OPEN_EVENT, openPlugins);
    return () => window.removeEventListener(PLUGIN_OPEN_EVENT, openPlugins);
  }, [activePid, configuration.search, configuration.select, requestedPage]);
  const currentKey = instanceKeyOf(activePage, activePid);
  const [seenKeys, setSeenKeys] = useState<string[]>([]);
  const homeKey = activePid ? instanceKeyOf("home", activePid) : null;
  const renderedKeys = Array.from(
    new Set([...seenKeys, ...(homeKey ? [homeKey] : []), currentKey])
  );

  useEffect(() => {
    if (!activePid && activePage !== "settings") return;
    setSeenKeys((keys) =>
      keys.includes(currentKey) && (!homeKey || keys.includes(homeKey))
        ? keys
        : Array.from(new Set([...keys, ...(homeKey ? [homeKey] : []), currentKey]))
    );
  }, [activePage, activePid, currentKey, homeKey]);

  useLayoutEffect(() => {
    const previousHandler = window.__BAAS_ANDROID_HANDLE_BACK__;
    const isVisible = (element: Element) =>
      element.getClientRects().length > 0 && !element.closest("[aria-hidden='true'],[hidden]");
    const handleBack = () => {
      const layer = Array.from(
        document.querySelectorAll(
          "[role='dialog'],[role='alertdialog'],[role='menu'],[role='listbox'],[data-slot='popover-content']"
        )
      ).find(isVisible);
      if (layer) {
        // Radix and the shared modal focus handler both use Escape to dismiss.
        (document.activeElement ?? document.body).dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            code: "Escape",
            bubbles: true,
            cancelable: true,
          })
        );
        return true;
      }
      const focused = document.activeElement;
      if (
        focused instanceof HTMLInputElement &&
        focused.matches("[data-configuration-search],[data-settings-search-source]") &&
        isVisible(focused)
      ) {
        focused.blur();
        return true;
      }
      const destination = androidBackDestination(activePage);
      if (destination) {
        setActivePage(destination);
        return true;
      }
      return false;
    };
    window.__BAAS_ANDROID_HANDLE_BACK__ = handleBack;
    return () => {
      if (window.__BAAS_ANDROID_HANDLE_BACK__ === handleBack) {
        if (previousHandler) window.__BAAS_ANDROID_HANDLE_BACK__ = previousHandler;
        else delete window.__BAAS_ANDROID_HANDLE_BACK__;
      }
    };
  }, [activePage]);

  const renderPage = useCallback(
    (page: PageKey, pid?: string) => {
      switch (page) {
        case "home":
          return (
            <>
              <HomePage profileId={pid} />
              <HomeReadyMarker onReady={onReady} />
            </>
          );
        case "scheduler":
          return <SchedulerPage profileId={pid} />;
        case "configuration":
          return <ConfigurationPage profileId={pid} setActivePage={setActivePage} />;
        case "settings":
          return <SettingsPage />;
        default:
          return <HomePage profileId={pid} />;
      }
    },
    [onReady]
  );

  if ((!activeProfile || !activePid) && activePage !== "settings") {
    return (
      <MainLayout activePage={activePage} setActivePage={setActivePage}>
        <HomeReadyMarker onReady={onReady} />
      </MainLayout>
    );
  }

  return (
    <MainLayout activePage={activePage} setActivePage={setActivePage}>
      <div className="android-page-stack relative h-full min-h-0 min-w-0 flex-1 overflow-hidden">
        {renderedKeys.map((key) => {
          const separator = key.indexOf(":");
          const page = normalizePageKey(separator < 0 ? key : key.slice(0, separator));
          const pid = separator < 0 ? undefined : key.slice(separator + 1);
          if (page !== "settings" && !profiles.some((profile) => profile.id === pid)) return null;
          const isActive = key === currentKey;
          const content = (
            <Suspense fallback={<PageLoadingFallback />}>{renderPage(page, pid)}</Suspense>
          );
          return (
            <div
              key={key}
              className={`android-page-scroll absolute inset-0 overflow-y-auto ${isActive ? "" : "hidden"}`}
              data-page={page}
              aria-hidden={!isActive}
            >
              {/* react-window keeps its measurements while Home is cached. */}
              {page === "home" ? (
                content
              ) : (
                <PageActivity active={isActive} suspendDelayMs={0}>
                  {content}
                </PageActivity>
              )}
            </div>
          );
        })}
      </div>
    </MainLayout>
  );
};
const SetupPage = React.lazy(() => import("@/pages/SetupPage"));

/** Renders the initial page without clearing the startup shell to an empty Suspense fallback. */
const InitialPage: React.FC = () => {
  // LoadingPage hands off the original animated HTML shell only after the real
  // Android installer has committed, not when its lazy fallback commits.
  if (__WITH_ANDROID__) return <LoadingPage />;
  if (__WITH_TAURI__ && !__WITH_ANDROID__ && !__WITH_WEBUI__) {
    return (
      <StartupShellHandoff>
        <SetupPage />
      </StartupShellHandoff>
    );
  }
  return (
    <StartupShellHandoff>
      <LoadingPage />
    </StartupShellHandoff>
  );
};

/** Renders the wrapped app component. */
const WrappedApp: React.FC = () => {
  const [ready, setReady] = useState(false);
  const [hasReadyOnce, setHasReadyOnce] = useState(false);
  const [hideLoading, setHideLoading] = useState(false);
  const [homePainted, setHomePainted] = useState(false);
  const markHomePainted = useCallback(() => setHomePainted(true), []);
  const lowPerformanceMode = useUISetting((settings) => settings.lowPerformanceMode);
  const enableBAComet = useUISetting((settings) => settings.enableBAComet);

  useEffect(() => {
    if (ready) {
      setHasReadyOnce(true);
    }
  }, [ready]);

  useEffect(() => {
    void loadMainLayout();
    void loadHomePage();
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("low-performance-mode", lowPerformanceMode);
    return () => {
      document.documentElement.classList.remove("low-performance-mode");
    };
  }, [lowPerformanceMode]);

  useEffect(() => {
    if (lowPerformanceMode && homePainted) {
      setHideLoading(true);
    }
  }, [homePainted, lowPerformanceMode]);

  const loadingOpacity = homePainted ? 0 : 1;

  return (
    <>
      {!hideLoading && (
        <div
          onTransitionEnd={(event) => {
            if (event.currentTarget === event.target && homePainted) {
              setHideLoading(true);
            }
          }}
          className="fixed inset-0 z-100"
          style={{
            opacity: loadingOpacity,
            transition: lowPerformanceMode ? "none" : "opacity 200ms ease-out",
          }}
        >
          <Suspense fallback={null}>
            <InitialPage />
          </Suspense>
        </div>
      )}

      <Suspense fallback={null}>
        <AppProvider setReady={setReady}>
          {hasReadyOnce && (
            <TauriSelfUpdateProvider>
              <TauriShortcutProvider>
                {enableBAComet && !lowPerformanceMode && <BAComet />}
                <GlobalContextMenu />
                <GlobalAppearanceEffects />
                {__WITH_TAURI__ && <TauriServiceNotifier />}
                {__WITH_TAURI__ && !__WITH_ANDROID__ && <TauriScriptNotifier />}
                <Main onReady={markHomePainted} />
                <ConfigArchiveDropOverlay />
                {__WITH_WEBUI__ && !ready && <ReconnectingOverlay />}
                <Toaster />
              </TauriShortcutProvider>
            </TauriSelfUpdateProvider>
          )}
        </AppProvider>
      </Suspense>
    </>
  );
};

/** Share native viewport sizing with the isolated Android UI fixture. */
export function useAndroidViewport() {
  useEffect(() => {
    if (!__WITH_ANDROID__) return;
    const root = document.documentElement;
    root.lang = i18n.language;
    const previousPlatform = root.dataset.appPlatform;
    root.dataset.appPlatform = "android";
    const visualViewport = window.visualViewport;
    const viewportProperties = ["height", "top", "left", "width"] as const;
    let layoutHeight = window.innerHeight;
    let layoutWidth = window.innerWidth;
    const updateViewport = () => {
      const values = {
        height: visualViewport?.height ?? window.innerHeight,
        top: visualViewport?.offsetTop ?? 0,
        left: visualViewport?.offsetLeft ?? 0,
        width: visualViewport?.width ?? window.innerWidth,
      };
      const focused = document.activeElement;
      const editing =
        focused instanceof HTMLElement &&
        focused.matches("input,textarea,[contenteditable='true']");
      if (Math.abs(window.innerWidth - layoutWidth) > 80) {
        layoutHeight = window.innerHeight;
        layoutWidth = window.innerWidth;
      } else if (!editing) {
        layoutHeight = Math.max(layoutHeight, window.innerHeight);
      }
      root.dataset.androidKeyboardVisible = String(
        editing && Math.max(layoutHeight, window.innerHeight) - values.height > 120
      );
      for (const property of viewportProperties) {
        root.style.setProperty(`--android-viewport-${property}`, `${values[property]}px`);
      }
    };
    updateViewport();
    window.addEventListener("resize", updateViewport);
    visualViewport?.addEventListener("resize", updateViewport);
    visualViewport?.addEventListener("scroll", updateViewport);
    document.addEventListener("focusin", updateViewport);
    document.addEventListener("focusout", updateViewport);
    const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    const previousViewport = viewport?.content;
    if (__WITH_ANDROID__ && viewport) {
      viewport.content = "width=device-width, initial-scale=1, viewport-fit=cover";
    }
    /** Handles the on lang change interaction. */
    const onLangChange = (lng: string) => {
      document.documentElement.lang = lng;
    };
    i18n.on("languageChanged", onLangChange);
    return () => {
      i18n.off("languageChanged", onLangChange);
      window.removeEventListener("resize", updateViewport);
      visualViewport?.removeEventListener("resize", updateViewport);
      visualViewport?.removeEventListener("scroll", updateViewport);
      document.removeEventListener("focusin", updateViewport);
      document.removeEventListener("focusout", updateViewport);
      delete root.dataset.androidKeyboardVisible;
      for (const property of viewportProperties)
        root.style.removeProperty(`--android-viewport-${property}`);
      if (previousPlatform) root.dataset.appPlatform = previousPlatform;
      else delete root.dataset.appPlatform;
      if (viewport && previousViewport) viewport.content = previousViewport;
    };
  }, []);
}

/** Renders the app component. */
const App: React.FC = () => {
  useAndroidViewport();
  useAndroidSystemBars();
  return (
    <ThemeProvider>
      <UISettingsProvider>
        <AboutBaasProvider>
          <ProfileActionsProvider>
            <WrappedApp />
          </ProfileActionsProvider>
        </AboutBaasProvider>
      </UISettingsProvider>
    </ThemeProvider>
  );
};

export default App;

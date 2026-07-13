import React, { Suspense, useCallback, useEffect, useState } from "react";
import { AppProvider, useApp } from "@/context/AppContext";
import { ThemeProvider } from "@/context/ThemeProvider";
import { PageKey } from "@/types/app";
import i18n from "@/shared/I18nTranslator.ts";
import { UISettingsProvider, useUISetting } from "@/context/UISettingsProvider.tsx";
import LoadingPage from "@/pages/LoadingPage";
import StartupShellHandoff from "@/components/StartupShellHandoff";

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
const WikiPage = React.lazy(() => import("@/pages/WikiPage.tsx"));

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

/** Renders the main component. */
const Main: React.FC = () => {
  const [activePage, setActivePage] = React.useState<PageKey>("home");
  const { activeProfile } = useApp();
  const activePid = activeProfile?.id;
  const currentKey = instanceKeyOf(activePage, activePid);

  /**
   * Lazily instantiate the requested page while injecting the active profile id when applicable.
   */
  const renderPage = useCallback((page: PageKey, pid: string) => {
    switch (page) {
      case "home":
        return <HomePage profileId={pid} />;
      case "scheduler":
        return <SchedulerPage profileId={pid} />;
      case "configuration":
        return <ConfigurationPage profileId={pid} setActivePage={setActivePage} />;
      case "settings":
        return <SettingsPage />;
      case "wiki":
        return <WikiPage />;
      default:
        return null;
    }
  }, []);

  if (!activeProfile || !activePid) {
    return (
      <MainLayout activePage={activePage} setActivePage={setActivePage}>
        {null}
      </MainLayout>
    );
  }

  return (
    <MainLayout activePage={activePage} setActivePage={setActivePage}>
      <div className="relative flex-1 min-h-0 overflow-hidden scroll-embedded h-[calc(100%-70px)] lg:h-full">
        <div key={currentKey} className="absolute inset-0 overflow-y-auto scroll-embedded pr-2">
          <Suspense fallback={<PageLoadingFallback />}>
            {renderPage(activePage, activePid)}
          </Suspense>
        </div>
      </div>
    </MainLayout>
  );
};
const SetupPage = React.lazy(() => import("@/pages/SetupPage"));

/** Renders the initial page without clearing the startup shell to an empty Suspense fallback. */
const InitialPage: React.FC = () => {
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
  const lowPerformanceMode = useUISetting((settings) => settings.lowPerformanceMode);
  const enableBAComet = useUISetting((settings) => settings.enableBAComet);

  useEffect(() => {
    if (ready) {
      setHasReadyOnce(true);
    }
  }, [ready]);

  useEffect(() => {
    if (__WITH_ANDROID__ && !ready) return;
    void loadMainLayout();
    void loadHomePage();
  }, [ready]);

  useEffect(() => {
    document.documentElement.classList.toggle("low-performance-mode", lowPerformanceMode);
    return () => {
      document.documentElement.classList.remove("low-performance-mode");
    };
  }, [lowPerformanceMode]);

  useEffect(() => {
    if (lowPerformanceMode && hasReadyOnce) {
      setHideLoading(true);
    }
  }, [hasReadyOnce, lowPerformanceMode]);

  const loadingOpacity = hasReadyOnce ? 0 : 1;

  return (
    <>
      {!hideLoading && (
        <div
          onTransitionEnd={(event) => {
            if (event.currentTarget === event.target && hasReadyOnce) {
              setHideLoading(true);
            }
          }}
          className="fixed inset-0 z-100"
          style={{
            opacity: loadingOpacity,
            transition: lowPerformanceMode ? "none" : "opacity 200ms ease-out",
          }}
        >
          <Suspense fallback={<></>}>
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
                <Main />
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

/** Renders the app component. */
const App: React.FC = () => {
  useEffect(() => {
    document.documentElement.lang = i18n.language;
    /** Handles the on lang change interaction. */
    const onLangChange = (lng: string) => {
      document.documentElement.lang = lng;
    };
    i18n.on("languageChanged", onLangChange);
    return () => {
      i18n.off("languageChanged", onLangChange);
    };
  }, []);

  return (
    <ThemeProvider>
      <UISettingsProvider>
        <WrappedApp />
      </UISettingsProvider>
    </ThemeProvider>
  );
};

export default App;

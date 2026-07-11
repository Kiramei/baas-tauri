import React, { Suspense, useCallback, useEffect, useState } from "react";
import { AppProvider, useApp } from "@/context/AppContext";
import { ThemeProvider } from "@/context/ThemeProvider";
import GlobalContextMenu from "@/components/GlobalContextMenu";
import type { Variants } from "framer-motion";
import { motion, MotionConfig } from "framer-motion";
import { Toaster } from "@/components/ui/Sonner";
import { PageKey } from "@/types/app";
import i18n, { loadLocale } from "@/shared/I18nTranslator.ts";
import BAComet from "@/components/ui/BAComet.tsx";
import { UISettingsProvider, useUISettings } from "@/context/UISettingsProvider.tsx";
import { TauriShortcutProvider } from "@/context/TauriShortcutProvider.tsx";
import { TauriSelfUpdateProvider } from "@/context/TauriSelfUpdateProvider";
import ConfigArchiveDropOverlay from "@/components/ConfigArchiveDropOverlay";
import GlobalAppearanceEffects from "@/components/GlobalAppearanceEffects";
import TauriScriptNotifier from "@/components/TauriScriptNotifier";
import LoadingPage from "@/pages/LoadingPage";

const loadHomePage = () => import("@/pages/HomePage");
const loadMainLayout = () => import("@/components/layout/MainLayout");
const HomePage = React.lazy(loadHomePage);
const MainLayout = React.lazy(loadMainLayout);
const SchedulerPage = React.lazy(() => import("@/pages/SchedulerPage"));
const ConfigurationPage = React.lazy(() => import("@/pages/ConfigurationPage"));
const SettingsPage = React.lazy(() => import("@/pages/SettingsPage"));
const WikiPage = React.lazy(() => import("@/pages/WikiPage.tsx"));
const WebWikiViewer = React.lazy(() => import("@/components/WebWikiViewer"));
const ReconnectingOverlay = __WITH_WEBUI__
  ? React.lazy(() => import("@/components/ReconnectingOverlay.tsx"))
  : null;

/**
 * Shared motion variants that keep inactive pages mounted while keeping the transition lightweight.
 */
const variants: Variants = {
  show: {
    opacity: 1,
    x: 0,
    display: "block" as const,
    transition: { type: "tween" as const, duration: 0.2, ease: "easeOut" as const },
  },
  hide: {
    opacity: 0,
    x: -24,
    transition: { type: "tween" as const, duration: 0.2, ease: "easeOut" as const },
    transitionEnd: { display: "none" },
  },
};

const lowPerformanceVariants: Variants = {
  show: {
    opacity: 1,
    x: 0,
    display: "block" as const,
    transition: { duration: 0 },
  },
  hide: {
    opacity: 0,
    x: 0,
    transition: { duration: 0 },
    transitionEnd: { display: "none" },
  },
};

/**
 * Builds a stable key so each profile-specific page instance can preserve its internal state.
 */
const instanceKeyOf = (page: PageKey, pid?: string) =>
  page === "home" || page === "scheduler" || page === "configuration"
    ? `${page}:${pid ?? "none"}`
    : page;

/**
 * Extracts the page identifier and profile id from a composite key.
 */
const parseInstanceKey = (k: string): [PageKey, string | undefined] => {
  if (k.includes(":")) {
    const [p, pid] = k.split(":");
    return [p as PageKey, pid];
  }
  return [k as PageKey, undefined];
};

/** Renders the main component. */
const Main: React.FC = () => {
  const [activePage, setActivePage] = React.useState<PageKey>("home");
  const { activeProfile } = useApp();
  const { uiSettings } = useUISettings();
  const lowPerformanceMode = uiSettings.lowPerformanceMode;

  const activePid = activeProfile!.id;
  const currentKey = instanceKeyOf(activePage, activePid);

  const [seenKeys, setSeenKeys] = React.useState<string[]>([instanceKeyOf("home", activePid)]);

  // Track every page/profile combination that has been rendered so components keep their local state.
  React.useEffect(() => {
    setSeenKeys((prev) => (prev.includes(currentKey) ? prev : [...prev, currentKey]));
  }, [currentKey]);

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

  return (
    <MainLayout activePage={activePage} setActivePage={setActivePage}>
      <div className="relative flex-1 min-h-0 overflow-hidden scroll-embedded h-[calc(100%-70px)] lg:h-full">
        {seenKeys.map((instKey) => {
          const [page, pid] = parseInstanceKey(instKey);
          const isActive = instKey === currentKey;
          return (
            <motion.div
              key={instKey}
              className="absolute inset-0 overflow-y-auto scroll-embedded pr-2"
              variants={lowPerformanceMode ? lowPerformanceVariants : variants}
              initial={isActive ? "show" : "hide"}
              animate={isActive ? "show" : "hide"}
              style={{ pointerEvents: isActive ? "auto" : "none" }}
              aria-hidden={!isActive}
            >
              {renderPage(page, pid!)}
            </motion.div>
          );
        })}
      </div>
    </MainLayout>
  );
};
const SetupPage = React.lazy(() => import("@/pages/SetupPage"));

/** Renders the initial page without clearing the startup shell to an empty Suspense fallback. */
const InitialPage: React.FC = () => {
  if (__WITH_TAURI__ && !__WITH_ANDROID__ && !__WITH_WEBUI__) {
    return <SetupPage />;
  }
  return <LoadingPage />;
};

/** Renders the wrapped app component. */
const WrappedApp: React.FC = () => {
  const [ready, setReady] = useState(false);
  const [hasReadyOnce, setHasReadyOnce] = useState(false);
  const [hideLoading, setHideLoading] = useState(false);
  const { uiSettings } = useUISettings();
  const lowPerformanceMode = uiSettings.lowPerformanceMode;

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
    if (lowPerformanceMode && hasReadyOnce) {
      setHideLoading(true);
    }
  }, [hasReadyOnce, lowPerformanceMode]);

  return (
    <MotionConfig reducedMotion={lowPerformanceMode ? "always" : "never"}>
      {uiSettings.enableBAComet && !lowPerformanceMode && <BAComet />}
      <GlobalContextMenu />

      {!hideLoading && (
        <motion.div
          initial={false}
          animate={{ opacity: hasReadyOnce ? 0 : 1 }}
          transition={{ duration: lowPerformanceMode ? 0 : 0.2 }}
          onAnimationComplete={(definition) => {
            if (hasReadyOnce && (definition as any).opacity === 0) {
              setHideLoading(true);
            }
          }}
          className="fixed inset-0 z-100"
        >
          <Suspense fallback={<></>}>
            <InitialPage />
          </Suspense>
        </motion.div>
      )}

      <Suspense fallback={null}>
        <AppProvider setReady={setReady}>
          {hasReadyOnce && (
            <TauriSelfUpdateProvider>
              <TauriShortcutProvider>
                <GlobalAppearanceEffects />
                {__WITH_TAURI__ && <TauriScriptNotifier />}
                <Main />
                <ConfigArchiveDropOverlay />
                {__WITH_WEBUI__ && !ready && ReconnectingOverlay && <ReconnectingOverlay />}
                <Toaster />
              </TauriShortcutProvider>
            </TauriSelfUpdateProvider>
          )}
        </AppProvider>
      </Suspense>
    </MotionConfig>
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

  useEffect(() => {
    loadLocale(i18n.language || "en").then(undefined);
  }, []);

  const isWebWikiWindow =
    !__WITH_ANDROID__ && new URLSearchParams(window.location.search).get("view") === "web-wiki";

  return (
    <ThemeProvider>
      <UISettingsProvider>
        <Suspense fallback={null}>{isWebWikiWindow ? <WebWikiViewer /> : <WrappedApp />}</Suspense>
      </UISettingsProvider>
    </ThemeProvider>
  );
};

export default App;

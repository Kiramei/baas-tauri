import React, { Suspense, useCallback, useEffect, useState } from "react";
import { AppProvider, useApp } from "@/context/AppContext";
import { ThemeProvider } from "@/context/ThemeProvider";
import GlobalContextMenu from "@/components/GlobalContextMenu";
import type { Variants } from "framer-motion";
import { motion, MotionConfig } from "framer-motion";
import { Toaster } from "@/components/ui/Sonner";
import { PageKey } from "@/types/app";
import i18n from "@/shared/I18nTranslator.ts";
import BAComet from "@/components/ui/BAComet.tsx";
import { UISettingsProvider, useUISetting } from "@/context/UISettingsProvider.tsx";
import ReconnectingOverlay from "@/components/ReconnectingOverlay.tsx";
import { TauriShortcutProvider } from "@/context/TauriShortcutProvider.tsx";
import { TauriSelfUpdateProvider } from "@/context/TauriSelfUpdateProvider";
import ConfigArchiveDropOverlay from "@/components/ConfigArchiveDropOverlay";
import GlobalAppearanceEffects from "@/components/GlobalAppearanceEffects";
import TauriScriptNotifier from "@/components/TauriScriptNotifier";
import TauriServiceNotifier from "@/components/TauriServiceNotifier";
import LoadingPage from "@/pages/LoadingPage";
import MainLayout from "@/components/layout/MainLayout";
import HomePage from "@/pages/HomePage";
import SchedulerPage from "@/pages/SchedulerPage";
import ConfigurationPage from "@/pages/ConfigurationPage";
import SettingsPage from "@/pages/SettingsPage";
import WikiPage from "@/pages/WikiPage.tsx";
import WebWikiViewer from "@/components/WebWikiViewer";
import PageActivity from "@/components/PageActivity";
import SetupPage from "@/pages/SetupPage";
import StartupShellHandoff from "@/components/StartupShellHandoff";

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
  const lowPerformanceMode = useUISetting((settings) => settings.lowPerformanceMode);
  const activePid = activeProfile?.id;
  const currentKey = instanceKeyOf(activePage, activePid);

  const [seenKeys, setSeenKeys] = React.useState<string[]>(() =>
    activePid ? [instanceKeyOf("home", activePid)] : []
  );

  // Track every page/profile combination that has been rendered so components keep their local state.
  React.useEffect(() => {
    if (!activePid) return;
    setSeenKeys((prev) => (prev.includes(currentKey) ? prev : [...prev, currentKey]));
  }, [activePid, currentKey]);

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

  const renderedKeys = seenKeys.includes(currentKey) ? seenKeys : [...seenKeys, currentKey];

  return (
    <MainLayout activePage={activePage} setActivePage={setActivePage}>
      <div className="relative flex-1 min-h-0 overflow-hidden scroll-embedded h-[calc(100%-70px)] lg:h-full">
        {renderedKeys.map((instKey) => {
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
              <PageActivity active={isActive} suspendDelayMs={lowPerformanceMode ? 0 : 200}>
                {renderPage(page, pid ?? activePid)}
              </PageActivity>
            </motion.div>
          );
        })}
      </div>
    </MainLayout>
  );
};
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
      {enableBAComet && !lowPerformanceMode && <BAComet />}
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
          <InitialPage />
        </motion.div>
      )}

      <Suspense fallback={null}>
        <AppProvider setReady={setReady}>
          {hasReadyOnce && (
            <TauriSelfUpdateProvider>
              <TauriShortcutProvider>
                <GlobalAppearanceEffects />
                {__WITH_TAURI__ && <TauriServiceNotifier />}
                {__WITH_TAURI__ && <TauriScriptNotifier />}
                <Main />
                <ConfigArchiveDropOverlay />
                {__WITH_WEBUI__ && !ready && <ReconnectingOverlay />}
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

  const isWebWikiWindow = new URLSearchParams(window.location.search).get("view") === "web-wiki";

  return (
    <ThemeProvider>
      <UISettingsProvider>
        {isWebWikiWindow ? (
          <StartupShellHandoff>
            <WebWikiViewer />
          </StartupShellHandoff>
        ) : (
          <WrappedApp />
        )}
      </UISettingsProvider>
    </ThemeProvider>
  );
};

export default App;

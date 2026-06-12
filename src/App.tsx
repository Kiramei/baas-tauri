import React, { Suspense, useCallback, useEffect, useState } from "react";
import { AppProvider, useApp } from "@/context/AppContext";
import { ThemeProvider } from "@/context/ThemeProvider";
import MainLayout from "@/components/layout/MainLayout";
import HomePage from "@/pages/HomePage";
import SchedulerPage from "@/pages/SchedulerPage";
import ConfigurationPage from "@/pages/ConfigurationPage";
import SettingsPage from "@/pages/SettingsPage";
import WikiPage from "@/pages/WikiPage.tsx";
import type { Variants } from "framer-motion";
import { motion } from "framer-motion";
import { Toaster } from "@/components/ui/Sonner";
import { PageKey } from "@/types/app";
import i18n, { loadLocale } from "@/shared/I18nTranslator.ts";
import BAComet from "@/components/ui/BAComet.tsx";
import { UISettingsProvider, useUISettings } from "@/context/UISettingsProvider.tsx";
import ReconnectingOverlay from "@/components/ReconnectingOverlay.tsx";

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

const Main: React.FC = () => {
  const [activePage, setActivePage] = React.useState<PageKey>("home");
  const { activeProfile } = useApp();

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
              variants={variants}
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
const InitialPage = React.lazy(async () => {
  if (__WITH_WEBUI__) return import("@/pages/LoadingPage");
  if (__WITH_TAURI__) return import("@/pages/SetupPage");
  return import("@/pages/LoadingPage");
});

const WrappedApp: React.FC = () => {
  const [ready, setReady] = useState(false);
  const [hasReadyOnce, setHasReadyOnce] = useState(false);
  const [hideLoading, setHideLoading] = useState(false);
  const { uiSettings } = useUISettings();

  useEffect(() => {
    if (ready) {
      setHasReadyOnce(true);
    }
  }, [ready]);

  return (
    <>
      {uiSettings.enableBAComet && <BAComet />}

      {!hideLoading && (
        <motion.div
          initial={false}
          animate={{ opacity: hasReadyOnce ? 0 : 1 }}
          transition={{ duration: 0.2 }}
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
            <>
              <Main />
              {!ready && <ReconnectingOverlay />}
              <Toaster />
            </>
          )}
        </AppProvider>
      </Suspense>
    </>
  );
};

const App: React.FC = () => {
  useEffect(() => {
    document.documentElement.lang = i18n.language;
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

  return (
    <>
      <ThemeProvider>
        <UISettingsProvider>
          <WrappedApp />
        </UISettingsProvider>
      </ThemeProvider>
    </>
  );
};

export default App;

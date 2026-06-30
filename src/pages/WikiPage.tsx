import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, ExternalLink, Loader2, Maximize2, RotateCcw } from "lucide-react";
import AndroidRemoteWiki from "@/components/AndroidRemoteWiki";
import { Button } from "@/components/ui/Button";
import {
  getWebWikiWindow,
  openWebWikiWindow,
  WEB_WIKI_URL,
  webWikiEvents,
} from "@/components/WebWikiViewer";

const webWikiLoadTimeoutMs = 20000;

/** Renders the wiki page component. */
const WikiPage: React.FC = () => {
  const { t } = useTranslation();
  const [detached, setDetached] = useState(false);
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "failed">("loading");

  useEffect(() => {
    if (!__WITH_TAURI__ || __WITH_ANDROID__) return;

    let cleanup: Array<() => void> = [];
    (async () => {
      const detachedWindow = await getWebWikiWindow();
      setDetached(Boolean(detachedWindow));

      const { listen } = await import("@tauri-apps/api/event");
      cleanup = [
        await listen(webWikiEvents.closed, () => {
          setDetached(false);
          setLoadState("loading");
        }),
        await listen(webWikiEvents.shown, () => setDetached(true)),
      ];
    })().catch(console.error);

    return () => {
      cleanup.forEach((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    if (detached || loadState !== "loading") return;
    const timer = window.setTimeout(() => setLoadState("failed"), webWikiLoadTimeoutMs);
    return () => window.clearTimeout(timer);
  }, [detached, loadState]);

  /** Handles the detach wiki workflow. */
  const detachWiki = useCallback(async () => {
    if (__WITH_ANDROID__) return;
    if (!__WITH_TAURI__) {
      window.open(WEB_WIKI_URL, "_blank", "noopener,noreferrer");
      return;
    }

    setDetached(true);
    setLoadState("loading");
    await openWebWikiWindow("detached", t("wiki.web.title"));
  }, [t]);

  /** Performs the open wiki in browser operation. */
  const openWikiInBrowser = useCallback(async () => {
    if (__WITH_TAURI__) {
      try {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(WEB_WIKI_URL);
        return;
      } catch (error) {
        console.error("[wiki] failed to open system browser:", error);
      }
    }

    window.open(WEB_WIKI_URL, "_blank", "noopener,noreferrer");
  }, []);

  /** Handles the focus detached wiki workflow. */
  const focusDetachedWiki = useCallback(async () => {
    if (__WITH_ANDROID__) return;
    const detachedWindow = await getWebWikiWindow();
    if (!detachedWindow) {
      setDetached(false);
      return;
    }
    await detachedWindow.show();
    await detachedWindow.setFocus();
  }, []);

  /** Handles the return to main workflow. */
  const returnToMain = useCallback(async () => {
    if (__WITH_ANDROID__) return;
    const detachedWindow = await getWebWikiWindow();
    await detachedWindow?.destroy().catch(console.error);
    setDetached(false);
    setLoadState("loading");
  }, []);

  if (__WITH_ANDROID__) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <header className="mb-4 flex shrink-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
              {t("wiki.title")}
            </h1>
            <p className="max-w-3xl text-sm text-slate-600 dark:text-slate-400">
              {t("wiki.subtitle")}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            className="self-start sm:self-auto"
            onClick={() => openWikiInBrowser().catch(console.error)}
          >
            <ExternalLink className="h-4 w-4" />
            {t("wiki.web.openBrowser")}
          </Button>
        </header>

        <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700">
          <AndroidRemoteWiki />
        </div>
      </div>
    );
  }

  if (detached) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <header className="mb-4 flex shrink-0 items-start justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
              {t("wiki.title")}
            </h1>
            <p className="max-w-3xl text-sm text-slate-600 dark:text-slate-400">
              {t("wiki.subtitle")}
            </p>
          </div>
        </header>

        <div className="flex flex-1 flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-slate-300 bg-white/70 p-8 text-center dark:border-slate-700 dark:bg-slate-900/50">
          <Maximize2 className="h-10 w-10 text-primary-500" />
          <div className="space-y-1">
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              {t("wiki.web.detachedTitle")}
            </h2>
            <p className="max-w-lg text-sm text-slate-600 dark:text-slate-400">
              {t("wiki.web.detachedDescription")}
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <Button type="button" onClick={() => focusDetachedWiki().catch(console.error)}>
              <ExternalLink className="h-4 w-4" />
              {t("wiki.web.focusDetached")}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => returnToMain().catch(console.error)}
            >
              <RotateCcw className="h-4 w-4" />
              {t("wiki.web.return")}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="mb-4 flex shrink-0 items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
            {t("wiki.title")}
          </h1>
          <p className="max-w-3xl text-sm text-slate-600 dark:text-slate-400">
            {t("wiki.subtitle")}
          </p>
        </div>
        <Button type="button" size="sm" onClick={() => detachWiki().catch(console.error)}>
          <ExternalLink className="h-4 w-4" />
          {__WITH_TAURI__ ? t("wiki.web.detach") : t("wiki.web.openExternal")}
        </Button>
      </header>

      <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700">
        <iframe
          title={t("wiki.web.title")}
          src={WEB_WIKI_URL}
          onLoad={() => setLoadState("loaded")}
          onError={() => setLoadState("failed")}
          className="h-full w-full border-0 bg-white"
          sandbox="allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-presentation allow-same-origin allow-scripts"
        />

        {loadState === "loading" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-950 text-slate-100">
            <Loader2 className="h-8 w-8 animate-spin text-primary-400" />
            <p className="text-sm">{t("wiki.web.loading")}</p>
          </div>
        )}

        {loadState === "failed" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-950 px-6 text-center text-slate-100">
            <AlertCircle className="h-9 w-9 text-red-400" />
            <h2 className="text-lg font-semibold">{t("wiki.web.failed")}</h2>
            <p className="max-w-md text-sm text-slate-400">{WEB_WIKI_URL}</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default WikiPage;

import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, ExternalLink, Loader2 } from "lucide-react";
import AndroidRemoteWiki from "@/components/AndroidRemoteWiki";
import { Button } from "@/components/ui/Button";
import { WEB_WIKI_URL } from "@/shared/Wiki";

const webWikiLoadTimeoutMs = 20000;

const WikiPage: React.FC = () => {
  const { t } = useTranslation();
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "failed">("loading");

  useEffect(() => {
    if (loadState !== "loading") return;
    const timer = window.setTimeout(() => setLoadState("failed"), webWikiLoadTimeoutMs);
    return () => window.clearTimeout(timer);
  }, [loadState]);

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

  if (__WITH_ANDROID__) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <header className="mb-4 flex shrink-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <h1 className="text-xl font-semibold tracking-tight text-foreground">
              {t("wiki.title")}
            </h1>
            <p className="max-w-3xl text-sm text-muted-foreground">{t("wiki.subtitle")}</p>
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

        <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-card">
          <AndroidRemoteWiki />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="mb-4 flex shrink-0 items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            {t("wiki.title")}
          </h1>
          <p className="max-w-3xl text-sm text-muted-foreground">{t("wiki.subtitle")}</p>
        </div>
        <Button type="button" size="sm" onClick={() => openWikiInBrowser().catch(console.error)}>
          <ExternalLink className="h-4 w-4" />
          {t("wiki.web.openBrowser")}
        </Button>
      </header>

      <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-card">
        <iframe
          title={t("wiki.web.title")}
          src={WEB_WIKI_URL}
          onLoad={() => setLoadState("loaded")}
          onError={() => setLoadState("failed")}
          className="h-full w-full border-0 bg-white"
          sandbox="allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-presentation allow-same-origin allow-scripts"
        />

        {loadState === "loading" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background text-foreground">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            <p className="text-sm">{t("wiki.web.loading")}</p>
          </div>
        )}

        {loadState === "failed" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background px-6 text-center text-foreground">
            <AlertCircle className="h-9 w-9 text-red-400" />
            <h2 className="text-lg font-semibold">{t("wiki.web.failed")}</h2>
            <p className="max-w-md text-sm text-muted-foreground">{WEB_WIKI_URL}</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default WikiPage;

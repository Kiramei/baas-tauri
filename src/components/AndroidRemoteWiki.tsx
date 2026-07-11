import React, { useEffect, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { resolveHttpBase } from "@/store/BackendStore";

const LOAD_TIMEOUT_MS = 20000;

/** Renders the android remote wiki component. */
const AndroidRemoteWiki: React.FC = () => {
  const { t } = useTranslation();
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "failed">("loading");
  const wikiUrl = `${resolveHttpBase()}/android/wiki/proxy?path=${encodeURIComponent("/")}`;

  useEffect(() => {
    if (loadState !== "loading") return;
    const timer = window.setTimeout(() => setLoadState("failed"), LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [loadState]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-white dark:bg-slate-950">
      <iframe
        title={t("wiki.web.title")}
        src={wikiUrl}
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
          <p className="max-w-md text-sm text-slate-400">{wikiUrl}</p>
        </div>
      )}
    </div>
  );
};

export default AndroidRemoteWiki;

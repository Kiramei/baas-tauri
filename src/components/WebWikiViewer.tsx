import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, Loader2 } from "lucide-react";

export const WEB_WIKI_URL = import.meta.env.VITE_BAAS_WIKI_URL || "https://baas.kiramei.cn";
export const WEB_WIKI_WINDOW_LABEL = "baas-wiki-viewer";
export const WEB_WIKI_MAIN_LABEL = "main";
export const WEB_WIKI_QUERY = "view=web-wiki";

export const webWikiEvents = {
  closed: "wiki:closed",
  shown: "wiki:shown",
} as const;

export type WebWikiMode = "detached";

const DETACHED_WINDOW_WIDTH = 1120;
const DETACHED_WINDOW_HEIGHT = 760;
const LOAD_TIMEOUT_MS = 20000;

async function resolveDetachedWindowPlacement() {
  try {
    const { Window } = await import("@tauri-apps/api/window");
    const main = await Window.getByLabel(WEB_WIKI_MAIN_LABEL);
    if (!main) return {};

    const scaleFactor = await main.scaleFactor();
    const mainPosition = (await main.outerPosition()).toLogical(scaleFactor);
    const mainSize = (await main.innerSize()).toLogical(scaleFactor);

    return {
      x: Math.round(mainPosition.x + Math.max(24, (mainSize.width - DETACHED_WINDOW_WIDTH) / 2)),
      y: Math.round(mainPosition.y + 56),
    };
  } catch (err) {
    console.error("[wiki] failed to resolve detached wiki window placement:", err);
    return {};
  }
}

export async function getWebWikiWindow() {
  if (!__WITH_TAURI__) return null;
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  return WebviewWindow.getByLabel(WEB_WIKI_WINDOW_LABEL);
}

export async function openWebWikiWindow(mode: WebWikiMode = "detached", title = "Wiki Docs") {
  if (!__WITH_TAURI__) return null;

  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const existing = await WebviewWindow.getByLabel(WEB_WIKI_WINDOW_LABEL);
  if (existing) {
    await existing.setTitle(title).catch(console.error);
    await existing.emit("wiki:set-mode", mode);
    await existing.show();
    await existing.setFocus();
    return existing;
  }

  const windowUrl = `/?${WEB_WIKI_QUERY}&mode=${mode}`;
  const placement = await resolveDetachedWindowPlacement();
  const wikiWindow = new WebviewWindow(WEB_WIKI_WINDOW_LABEL, {
    url: windowUrl,
    title,
    width: DETACHED_WINDOW_WIDTH,
    height: DETACHED_WINDOW_HEIGHT,
    minWidth: 720,
    minHeight: 480,
    ...placement,
    center: false,
    visible: true,
    focus: true,
    decorations: true,
    resizable: true,
    fullscreen: false,
    alwaysOnTop: false,
  });

  wikiWindow.once("tauri://created", () => {
    wikiWindow.emit("wiki:set-mode", mode).catch(console.error);
    wikiWindow.emitTo(WEB_WIKI_MAIN_LABEL, webWikiEvents.shown).catch(console.error);
  });
  wikiWindow.once("tauri://error", (event) => {
    console.error("[wiki] failed to create web wiki window:", event.payload);
  });

  return wikiWindow;
}

async function currentWindow() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

async function emitToMain(event: string) {
  const window = await currentWindow();
  await window.emitTo(WEB_WIKI_MAIN_LABEL, event);
}

async function applyDetachedWindowLayout() {
  const { LogicalSize } = await import("@tauri-apps/api/dpi");
  const window = await currentWindow();

  await window.setFullscreen(false).catch(console.error);
  await window.setAlwaysOnTop(false).catch(console.error);
  await window
    .setSize(new LogicalSize(DETACHED_WINDOW_WIDTH, DETACHED_WINDOW_HEIGHT))
    .catch(console.error);
  await window.show();
  await window.setFocus();
}

const WebWikiViewer: React.FC = () => {
  const { t } = useTranslation();
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "failed">("loading");

  useEffect(() => {
    applyDetachedWindowLayout().catch(console.error);
  }, []);

  useEffect(() => {
    if (!__WITH_TAURI__) return;

    let cleanup: Array<() => void> = [];
    let closing = false;
    (async () => {
      const appWindow = await currentWindow();
      cleanup = [
        await appWindow.onCloseRequested(async (event) => {
          event.preventDefault();
          if (closing) return;

          closing = true;
          await emitToMain(webWikiEvents.closed).catch(console.error);
          await appWindow.destroy().catch(console.error);
        }),
      ];
    })().catch(console.error);

    return () => {
      cleanup.forEach((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    if (loadState !== "loading") return;
    const timer = window.setTimeout(() => setLoadState("failed"), LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [loadState]);

  return (
    <main className="h-screen w-screen overflow-hidden bg-white">
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
          <h1 className="text-lg font-semibold">{t("wiki.web.failed")}</h1>
          <p className="max-w-md text-sm text-slate-400">{WEB_WIKI_URL}</p>
        </div>
      )}
    </main>
  );
};

export default WebWikiViewer;

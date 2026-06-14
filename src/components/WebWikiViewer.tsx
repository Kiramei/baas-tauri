import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, Loader2 } from "lucide-react";
import { cn } from "@/shared/GlobalUtilities";

export const WEB_WIKI_URL = "https://baas.wiki";
export const WEB_WIKI_WINDOW_LABEL = "baas-wiki-viewer";
export const WEB_WIKI_MAIN_LABEL = "main";
export const WEB_WIKI_QUERY = "view=web-wiki";

export const webWikiEvents = {
  closed: "wiki:closed",
  pinned: "wiki:pinned",
  returnMain: "wiki:return-main",
  shown: "wiki:shown",
} as const;

export type WebWikiMode = "detached";

const DETACHED_WINDOW_WIDTH = 1120;
const DETACHED_WINDOW_HEIGHT = 760;
const LOAD_TIMEOUT_MS = 20000;

const trafficLightBase =
  "h-3 w-3 rounded-full border border-black/10 shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70";

async function resolveDetachedWindowPlacement() {
  try {
    const { Window } = await import("@tauri-apps/api/window");
    const main = await Window.getByLabel(WEB_WIKI_MAIN_LABEL);
    if (!main) return { placement: {}, mainPosition: null };

    const scaleFactor = await main.scaleFactor();
    const mainPosition = (await main.outerPosition()).toLogical(scaleFactor);
    const mainSize = (await main.innerSize()).toLogical(scaleFactor);

    return {
      placement: {
        x: Math.round(mainPosition.x + Math.max(24, (mainSize.width - DETACHED_WINDOW_WIDTH) / 2)),
        y: Math.round(mainPosition.y + 56),
      },
      mainPosition,
    };
  } catch (err) {
    console.error("[wiki] failed to resolve detached wiki window placement:", err);
    return { placement: {}, mainPosition: null };
  }
}

async function restoreMainWindowPosition(
  position: Awaited<ReturnType<typeof resolveDetachedWindowPlacement>>["mainPosition"]
) {
  if (!position) return;
  try {
    const { Window } = await import("@tauri-apps/api/window");
    const main = await Window.getByLabel(WEB_WIKI_MAIN_LABEL);
    await main?.setPosition(position);
  } catch (err) {
    console.error("[wiki] failed to restore main window position:", err);
  }
}

export async function getWebWikiWindow() {
  if (!__WITH_TAURI__) return null;
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  return WebviewWindow.getByLabel(WEB_WIKI_WINDOW_LABEL);
}

export async function openWebWikiWindow(mode: WebWikiMode = "detached") {
  if (!__WITH_TAURI__) return null;

  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const existing = await WebviewWindow.getByLabel(WEB_WIKI_WINDOW_LABEL);
  if (existing) {
    await existing.emit("wiki:set-mode", mode);
    await existing.show();
    await existing.setFocus();
    return existing;
  }

  const windowUrl = `/?${WEB_WIKI_QUERY}&mode=${mode}`;
  const { placement, mainPosition } = await resolveDetachedWindowPlacement();
  const wikiWindow = new WebviewWindow(WEB_WIKI_WINDOW_LABEL, {
    url: windowUrl,
    title: "BAAS Wiki",
    width: DETACHED_WINDOW_WIDTH,
    height: DETACHED_WINDOW_HEIGHT,
    minWidth: 720,
    minHeight: 480,
    ...placement,
    center: false,
    visible: true,
    focus: true,
    decorations: false,
    resizable: true,
    fullscreen: false,
    alwaysOnTop: false,
  });

  wikiWindow.once("tauri://created", () => {
    wikiWindow.emit("wiki:set-mode", mode).catch(console.error);
    restoreMainWindowPosition(mainPosition).catch(console.error);
    window.setTimeout(() => restoreMainWindowPosition(mainPosition).catch(console.error), 250);
    window.setTimeout(() => restoreMainWindowPosition(mainPosition).catch(console.error), 1000);
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
  const [mode, setMode] = useState<WebWikiMode>("detached");
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "failed">("loading");

  useEffect(() => {
    applyDetachedWindowLayout().catch(console.error);
  }, [mode]);

  useEffect(() => {
    if (!__WITH_TAURI__) return;

    let cleanup: Array<() => void> = [];
    (async () => {
      const window = await currentWindow();
      cleanup = [
        await window.listen<WebWikiMode>("wiki:set-mode", (event) => {
          setMode(event.payload);
        }),
        await window.listen("tauri://close-requested", () => {
          emitToMain(webWikiEvents.closed).catch(console.error);
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

  const closeWindow = useCallback(async () => {
    if (!__WITH_TAURI__) return;
    await emitToMain(webWikiEvents.closed).catch(console.error);
    const window = await currentWindow();
    await window.destroy();
  }, []);

  const returnToMain = useCallback(async () => {
    if (!__WITH_TAURI__) return;
    await emitToMain(webWikiEvents.returnMain).catch(console.error);
    const window = await currentWindow();
    await window.destroy();
  }, []);

  const pinToPage = useCallback(async () => {
    if (!__WITH_TAURI__) return;
    await emitToMain(webWikiEvents.pinned).catch(console.error);
    const window = await currentWindow();
    await window.hide();
  }, []);

  const startWindowDrag = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (!__WITH_TAURI__ || event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button")) return;
    currentWindow()
      .then((window) => window.startDragging())
      .catch(console.error);
  }, []);

  return (
    <main className="flex h-screen w-screen overflow-hidden bg-slate-950 text-white">
      <section className="flex h-full w-full flex-col overflow-hidden border border-white/10 bg-slate-950">
        <header
          className="flex h-11 shrink-0 items-center justify-between border-b border-white/10 bg-slate-900/95 px-4"
          data-tauri-drag-region
          onPointerDown={startWindowDrag}
        >
          <div className="flex items-center gap-2" data-tauri-drag-region>
            <button
              type="button"
              title={t("wiki.web.close")}
              aria-label={t("wiki.web.close")}
              onClick={closeWindow}
              className={cn(trafficLightBase, "bg-[#ff5f57] hover:bg-[#ff6f68]")}
            />
            <button
              type="button"
              title={t("wiki.web.return")}
              aria-label={t("wiki.web.return")}
              onClick={returnToMain}
              className={cn(trafficLightBase, "bg-[#febc2e] hover:bg-[#ffd15c]")}
            />
            <button
              type="button"
              title={t("wiki.web.pin")}
              aria-label={t("wiki.web.pin")}
              onClick={pinToPage}
              className={cn(trafficLightBase, "bg-[#28c840] hover:bg-[#4cda64]")}
            />
          </div>
          <div
            className="pointer-events-none absolute left-1/2 -translate-x-1/2 text-sm font-medium text-slate-100"
            data-tauri-drag-region
          >
            {t("wiki.web.title")}
          </div>
          <div className="h-3 w-16" data-tauri-drag-region />
        </header>

        <div className="relative min-h-0 flex-1 overflow-hidden bg-white">
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
        </div>
      </section>
    </main>
  );
};

export default WebWikiViewer;

import React, { useEffect, useRef, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import type { Webview as TauriWebview } from "@tauri-apps/api/webview";
import { observeResizeOnAnimationFrame } from "@/shared/AnimationFrameResizeObserver";

export const WEB_WIKI_URL = import.meta.env.VITE_BAAS_WIKI_URL || "https://baas.kiramei.cn";
export const WEB_WIKI_WINDOW_LABEL = "baas-wiki-viewer";
export const WEB_WIKI_EMBEDDED_LABEL = "baas-wiki-embedded";
export const WEB_WIKI_MAIN_LABEL = "main";

export const webWikiEvents = {
  closed: "wiki:closed",
  shown: "wiki:shown",
} as const;

const DETACHED_WINDOW_WIDTH = 1120;
const DETACHED_WINDOW_HEIGHT = 760;

/** Returns a detached window position centered over the main window. */
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
  } catch (error) {
    console.error("[wiki] failed to resolve detached window placement:", error);
    return {};
  }
}

/** Returns the detached Wiki window when it exists. */
export async function getWebWikiWindow() {
  if (!__WITH_TAURI__) return null;
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  return WebviewWindow.getByLabel(WEB_WIKI_WINDOW_LABEL);
}

/** Opens the documentation directly in a standalone native WebView window. */
export async function openWebWikiWindow(title = "Wiki Docs") {
  if (!__WITH_TAURI__) return null;

  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const existing = await WebviewWindow.getByLabel(WEB_WIKI_WINDOW_LABEL);
  if (existing) {
    await existing.setTitle(title).catch(console.error);
    await existing.show();
    await existing.setFocus();
    return existing;
  }

  const placement = await resolveDetachedWindowPlacement();
  const wikiWindow = new WebviewWindow(WEB_WIKI_WINDOW_LABEL, {
    url: WEB_WIKI_URL,
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
    wikiWindow.emitTo(WEB_WIKI_MAIN_LABEL, webWikiEvents.shown).catch(console.error);
  });
  wikiWindow.once("tauri://destroyed", () => {
    wikiWindow.emitTo(WEB_WIKI_MAIN_LABEL, webWikiEvents.closed).catch(console.error);
  });
  wikiWindow.once("tauri://error", (event) => {
    console.error("[wiki] failed to create web wiki window:", event.payload);
  });

  return wikiWindow;
}

/** Hosts the documentation in a native child WebView aligned to this DOM placeholder. */
export const EmbeddedWebWiki: React.FC = () => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const webviewRef = useRef<TauriWebview | null>(null);
  const [state, setState] = useState<"loading" | "loaded" | "failed">("loading");

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !__WITH_TAURI__) return;

    let disposed = false;
    let created = false;
    let stopObserving: () => void = () => {};

    const updateBounds = async () => {
      const webview = webviewRef.current;
      if (!created || !webview || disposed) return;
      const rect = host.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      const { LogicalPosition, LogicalSize } = await import("@tauri-apps/api/dpi");
      await Promise.all([
        webview.setPosition(new LogicalPosition(Math.round(rect.left), Math.round(rect.top))),
        webview.setSize(new LogicalSize(Math.round(rect.width), Math.round(rect.height))),
      ]);
    };

    (async () => {
      const [{ Webview }, { getCurrentWindow }] = await Promise.all([
        import("@tauri-apps/api/webview"),
        import("@tauri-apps/api/window"),
      ]);
      const stale = await Webview.getByLabel(WEB_WIKI_EMBEDDED_LABEL);
      await stale?.close().catch(() => undefined);
      if (disposed) return;

      const rect = host.getBoundingClientRect();
      const webview = new Webview(getCurrentWindow(), WEB_WIKI_EMBEDDED_LABEL, {
        url: WEB_WIKI_URL,
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
        devtools: false,
      });
      webviewRef.current = webview;
      stopObserving = observeResizeOnAnimationFrame(host, () => void updateBounds());

      webview.once("tauri://created", () => {
        created = true;
        setState("loaded");
        void updateBounds();
      });
      webview.once("tauri://error", (event) => {
        console.error("[wiki] failed to create embedded webview:", event.payload);
        setState("failed");
      });
    })().catch((error) => {
      console.error("[wiki] failed to initialize embedded webview:", error);
      setState("failed");
    });

    return () => {
      disposed = true;
      stopObserving();
      const webview = webviewRef.current;
      webviewRef.current = null;
      void webview?.close().catch(() => undefined);
    };
  }, []);

  return (
    <div ref={hostRef} className="relative h-full w-full overflow-hidden bg-slate-950">
      {state === "loading" && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary-400" />
        </div>
      )}
      {state === "failed" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-slate-100">
          <AlertCircle className="h-9 w-9 text-red-400" />
          <p className="max-w-md text-sm text-slate-400">{WEB_WIKI_URL}</p>
        </div>
      )}
    </div>
  );
};

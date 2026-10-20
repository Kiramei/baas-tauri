import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Play } from "lucide-react";
import { toast } from "sonner";
import { invoke } from "@/shared/TauriInvoke";
import { AndroidNativePreviewOwnership } from "@/shared/AndroidNativePreviewOwnership";
import { useAppTranslation } from "@/shared/useAppTranslation";
import type { AndroidInstalledGame } from "@/shared/AndroidProfileGame";

type GameListReport = {
  games: AndroidInstalledGame[];
  shizukuInstalled: boolean;
  shizukuRunning: boolean;
  shizukuGranted: boolean;
};

let nativePreviewQueue: Promise<unknown> = Promise.resolve();
const nativePreviewOwnership = new AndroidNativePreviewOwnership();
const updateNativePreview = <T,>(request: Record<string, unknown>): Promise<T> => {
  const next = nativePreviewQueue
    .catch(() => undefined)
    .then(() => invoke<T>("android_game_native_preview", { request }));
  nativePreviewQueue = next;
  return next;
};

interface AndroidGamePanelProps {
  configuredPackage?: string;
  virtualDisplayActive: boolean;
  virtualDisplayBusy: boolean;
  onToggleVirtualDisplay: (active: boolean, packageName?: string) => Promise<void>;
}

/** Read-only live game preview backed by the privileged Android virtual display. */
const AndroidGamePanel: React.FC<AndroidGamePanelProps> = ({
  configuredPackage,
  virtualDisplayActive,
  virtualDisplayBusy,
  onToggleVirtualDisplay,
}) => {
  const { t, language } = useAppTranslation();
  const [games, setGames] = useState<AndroidInstalledGame[]>([]);
  const [shizukuGranted, setShizukuGranted] = useState(false);
  const [previewReady, setPreviewReady] = useState(false);
  const [takingOver, setTakingOver] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const previewRef = useRef<HTMLElement>(null);

  const selectedGame = useMemo(
    () => games.find((game) => game.packageName === configuredPackage) ?? null,
    [games, configuredPackage]
  );

  const loadGames = useCallback(async () => {
    try {
      const report = await invoke<GameListReport>("android_list_games");
      setGames(report.games);
      setShizukuGranted(report.shizukuGranted);
    } catch (error) {
      toast.error(t("android.game.inspectFailed"), { description: String(error) });
    }
  }, [t]);

  useEffect(() => {
    void loadGames();
    const refresh = () => void loadGames();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [loadGames, virtualDisplayActive]);

  useEffect(() => {
    const owner = {};
    let disposed = false;
    let inFlight = false;
    let updatePending = false;
    let animation = 0;
    let lastLayout = "";
    let lastPoll = 0;
    const update = async () => {
      if (disposed) return;
      if (inFlight) {
        updatePending = true;
        return;
      }
      updatePending = false;
      const bounds = previewRef.current?.getBoundingClientRect();
      let clipTop = 0;
      let clipBottom = window.innerHeight;
      for (let parent = previewRef.current?.parentElement; parent; parent = parent.parentElement) {
        if (/(auto|scroll|hidden)/.test(getComputedStyle(parent).overflowY)) {
          const rect = parent.getBoundingClientRect();
          clipTop = Math.max(clipTop, rect.top);
          clipBottom = Math.min(clipBottom, rect.bottom);
        }
      }
      const visible = Boolean(
        previewRef.current?.getClientRects().length &&
        !previewRef.current.closest("[hidden], [aria-hidden='true']") &&
        !document.hidden &&
        bounds &&
        bounds.width > 0 &&
        bounds.height > 0 &&
        bounds.bottom > clipTop &&
        bounds.top < clipBottom
      );
      if (!visible) {
        lastLayout = "";
        setPreviewReady(false);
        // All cached pages observe the DOM, but only the previous visible
        // owner may close the host, once. Others must leave it untouched.
        if (nativePreviewOwnership.release(owner)) {
          void updateNativePreview({ enabled: false }).catch(console.warn);
        }
        return;
      }
      nativePreviewOwnership.acquire(owner);
      const blocked = Array.from(
        document.querySelectorAll(
          '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-slot="popover-content"], [data-native-preview-blocker]'
        )
      ).some(
        (element) =>
          element.getClientRects().length > 0 &&
          !element.closest("[hidden], [aria-hidden='true']:not([data-native-preview-blocker])")
      );
      const enabled = Boolean(selectedGame && virtualDisplayActive && shizukuGranted && !blocked);
      const request = {
        enabled,
        language,
        x: bounds?.x ?? 0,
        y: bounds?.y ?? 0,
        width: bounds?.width ?? 0,
        height: bounds?.height ?? 0,
        viewportWidth: window.innerWidth,
        clipTop: Math.max(0, clipTop - (bounds?.top ?? 0)),
        clipBottom: Math.max(0, (bounds?.bottom ?? 0) - clipBottom),
      };
      const layout = JSON.stringify(request);
      const now = performance.now();
      if (layout === lastLayout && now - lastPoll < 1000) return;
      inFlight = true;
      lastLayout = layout;
      lastPoll = now;
      try {
        const report = await updateNativePreview<{
          ready?: boolean;
          capturedFrames?: number;
          error?: string;
        }>(request);
        if (!disposed && nativePreviewOwnership.owns(owner)) {
          setPreviewReady(enabled && Boolean(report.ready));
          if (report.error) console.warn("Native Android preview:", report.error);
        }
      } catch (error) {
        if (!disposed) console.warn("Native Android preview failed", error);
      } finally {
        inFlight = false;
        // A menu can open while a native layout request is pending. Apply its
        // visibility immediately afterward, rather than waiting for the next poll.
        if (updatePending && !disposed) schedule();
      }
    };
    const schedule = () => {
      window.cancelAnimationFrame(animation);
      animation = window.requestAnimationFrame(() => void update());
    };
    const poll = window.setInterval(() => void update(), 1000);
    const observer = new ResizeObserver(schedule);
    if (previewRef.current) observer.observe(previewRef.current);
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    document.addEventListener("visibilitychange", schedule);
    // Dialogs may cover the native host without changing its layout.
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "hidden",
        "aria-hidden",
        "class",
        "data-state",
        "data-native-preview-blocker",
      ],
    });
    schedule();
    return () => {
      disposed = true;
      window.cancelAnimationFrame(animation);
      window.clearInterval(poll);
      observer.disconnect();
      mutations.disconnect();
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("visibilitychange", schedule);
      if (nativePreviewOwnership.release(owner)) {
        void updateNativePreview({ enabled: false }).catch(console.warn);
      }
    };
  }, [language, selectedGame, shizukuGranted, virtualDisplayActive]);

  const startBackgroundDisplay = async () => {
    if (virtualDisplayBusy) return;
    await onToggleVirtualDisplay(true);
    await loadGames();
  };

  const closeBackgroundDisplay = async () => {
    if (virtualDisplayBusy) return;
    await onToggleVirtualDisplay(false, selectedGame?.packageName);
  };

  const takeOverGame = async () => {
    if (!selectedGame || !virtualDisplayActive || takingOver || virtualDisplayBusy) return;
    setTakingOver(true);
    try {
      await invoke("android_launch_game", { request: { packageName: selectedGame.packageName } });
      await onToggleVirtualDisplay(false, selectedGame.packageName);
    } catch (error) {
      toast.error(t("android.game.takeoverFailed"), { description: String(error) });
    } finally {
      setTakingOver(false);
    }
  };

  const restartGame = async () => {
    if (!selectedGame || restarting || virtualDisplayBusy) return;
    setRestarting(true);
    try {
      await onToggleVirtualDisplay(false, selectedGame.packageName);
      await new Promise((resolve) => window.setTimeout(resolve, 200));
      await onToggleVirtualDisplay(true, selectedGame.packageName);
    } catch (error) {
      toast.error(t("android.game.restartFailed"), { description: String(error) });
    } finally {
      setRestarting(false);
    }
  };

  useEffect(() => {
    const action = (event: Event) => {
      // Each profile keeps its Home mounted. Only the visible page owns game
      // controls; cached pages must not restart or close another profile's game.
      if (
        document.hidden ||
        !virtualDisplayActive ||
        !previewRef.current?.getClientRects().length ||
        previewRef.current.closest("[hidden], [aria-hidden='true']")
      )
        return;
      if (virtualDisplayBusy || takingOver || restarting) return;
      const name = (event as CustomEvent<string>).detail;
      if (name === "close") void closeBackgroundDisplay();
      else if (name === "takeover") void takeOverGame();
      else if (name === "restart") void restartGame();
    };
    window.addEventListener("android-game-action", action);
    return () => window.removeEventListener("android-game-action", action);
  });

  return (
    <section
      ref={previewRef}
      className="relative aspect-video w-full shrink-0 overflow-hidden rounded-xl bg-black shadow-sm ring-1 ring-slate-300/70 dark:ring-slate-700"
    >
      {virtualDisplayActive && (
        <div
          aria-label={t("android.game.liveDisplay", {
            game: selectedGame?.label ?? t("android.game.fallbackName"),
          })}
          className="absolute inset-0 block h-full w-full select-none object-cover"
        />
      )}

      <button
        type="button"
        aria-label={
          virtualDisplayActive ? t("android.game.showControls") : t("android.game.startBackground")
        }
        disabled={virtualDisplayBusy}
        onClick={() => {
          if (!virtualDisplayActive) void startBackgroundDisplay();
        }}
        className="absolute inset-0 z-10 grid h-full w-full place-items-center disabled:cursor-not-allowed"
      >
        {!virtualDisplayActive && (
          <span className="grid h-16 w-16 place-items-center rounded-full bg-primary-600 text-white shadow-xl shadow-black/35 transition active:scale-95 disabled:opacity-50">
            {virtualDisplayBusy ? (
              <Loader2 className="h-7 w-7 animate-spin" />
            ) : (
              <Play className="ml-1 h-7 w-7 fill-current" />
            )}
          </span>
        )}
        {virtualDisplayActive && !previewReady && (
          <Loader2 className="h-7 w-7 animate-spin text-white/80" />
        )}
      </button>

      {virtualDisplayActive && (
        <div className="pointer-events-none absolute right-2 top-2 z-30 flex items-center gap-1.5 rounded-full bg-black/65 px-2.5 py-1 text-[11px] font-semibold text-white">
          <span className={`h-2 w-2 rounded-full ${previewReady ? "bg-emerald-400" : "bg-slate-400"}`} />
          {previewReady ? t("android.game.live") : t("android.start.displayNotReady")}
        </div>
      )}
    </section>
  );
};

export default AndroidGamePanel;

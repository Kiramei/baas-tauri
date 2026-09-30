import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Play } from "lucide-react";
import { toast } from "sonner";
import { invoke } from "@/shared/TauriInvoke";

type AndroidGame = {
  packageName: string;
  label: string;
  iconPngBase64: string;
};

type GameListReport = {
  games: AndroidGame[];
  shizukuInstalled: boolean;
  shizukuRunning: boolean;
  shizukuGranted: boolean;
};

const SELECTED_GAME_KEY = "baasAndroidSelectedGame";

let nativePreviewQueue: Promise<unknown> = Promise.resolve();
const updateNativePreview = <T,>(request: Record<string, unknown>): Promise<T> => {
  const next = nativePreviewQueue
    .catch(() => undefined)
    .then(() => invoke<T>("android_game_native_preview", { request }));
  nativePreviewQueue = next;
  return next;
};

interface AndroidGamePanelProps {
  virtualDisplayActive: boolean;
  virtualDisplayBusy: boolean;
  onToggleVirtualDisplay: (active: boolean, packageName?: string) => Promise<void>;
}

/** Read-only live game preview backed by the privileged Android virtual display. */
const AndroidGamePanel: React.FC<AndroidGamePanelProps> = ({
  virtualDisplayActive,
  virtualDisplayBusy,
  onToggleVirtualDisplay,
}) => {
  const [games, setGames] = useState<AndroidGame[]>([]);
  const [selectedPackage, setSelectedPackage] = useState("");
  const [shizukuGranted, setShizukuGranted] = useState(false);
  const [previewReady, setPreviewReady] = useState(false);
  const [takingOver, setTakingOver] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const previewRef = useRef<HTMLElement>(null);

  const selectedGame = useMemo(
    () => games.find((game) => game.packageName === selectedPackage) ?? games[0] ?? null,
    [games, selectedPackage]
  );

  const loadGames = useCallback(async () => {
    try {
      const report = await invoke<GameListReport>("android_list_games");
      setGames(report.games);
      setShizukuGranted(report.shizukuGranted);
      setSelectedPackage((current) => {
        const preferred = current || window.localStorage.getItem(SELECTED_GAME_KEY) || "";
        const next = report.games.some((game) => game.packageName === preferred)
          ? preferred
          : (report.games[0]?.packageName ?? "");
        if (next) window.localStorage.setItem(SELECTED_GAME_KEY, next);
        return next;
      });
    } catch (error) {
      toast.error("Unable to inspect installed games", { description: String(error) });
    }
  }, []);

  useEffect(() => {
    void loadGames();
    const refresh = () => void loadGames();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [loadGames]);

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let animation = 0;
    let lastLayout = "";
    let lastPoll = 0;
    const update = async () => {
      if (disposed || inFlight) return;
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
      const enabled = Boolean(
        selectedGame &&
        virtualDisplayActive &&
        shizukuGranted &&
        !document.querySelector('[role="dialog"], [role="alertdialog"]') &&
        !document.hidden &&
        bounds &&
        bounds.bottom > clipTop &&
        bounds.top < clipBottom
      );
      const request = {
        enabled,
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
        if (!disposed) {
          setPreviewReady(enabled && Boolean(report.ready));
          if (report.error) console.warn("Native Android preview:", report.error);
        }
      } catch (error) {
        if (!disposed) console.warn("Native Android preview failed", error);
      } finally {
        inFlight = false;
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
    mutations.observe(document.body, { childList: true, subtree: true });
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
      void updateNativePreview({ enabled: false }).catch(console.warn);
    };
  }, [selectedGame, shizukuGranted, virtualDisplayActive]);

  const requestShizuku = async () => {
    try {
      await invoke("android_request_shizuku_permission");
      window.setTimeout(() => void loadGames(), 750);
    } catch (error) {
      toast.error("Shizuku setup needs attention", { description: String(error) });
    }
  };

  const startBackgroundDisplay = async () => {
    if (!selectedGame || virtualDisplayBusy) return;
    if (!shizukuGranted) {
      await requestShizuku();
      return;
    }
    await onToggleVirtualDisplay(true, selectedGame.packageName);
  };

  const closeBackgroundDisplay = async () => {
    if (virtualDisplayBusy) return;
    await onToggleVirtualDisplay(false, selectedGame?.packageName);
  };

  const takeOverGame = async () => {
    if (!selectedGame || takingOver || virtualDisplayBusy) return;
    setTakingOver(true);
    try {
      await onToggleVirtualDisplay(false, selectedGame.packageName);
      await invoke("android_launch_game", { request: { packageName: selectedGame.packageName } });
    } catch (error) {
      toast.error("Unable to take over the game", { description: String(error) });
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
      toast.error("Unable to restart the game", { description: String(error) });
    } finally {
      setRestarting(false);
    }
  };

  useEffect(() => {
    const action = (event: Event) => {
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
          aria-label={`${selectedGame?.label ?? "Game"} live display`}
          className="absolute inset-0 block h-full w-full select-none object-cover"
        />
      )}

      <button
        type="button"
        aria-label={virtualDisplayActive ? "Show game controls" : "Start background game"}
        disabled={!selectedGame || virtualDisplayBusy}
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
          <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)]" />
          Live
        </div>
      )}
    </section>
  );
};

export default AndroidGamePanel;

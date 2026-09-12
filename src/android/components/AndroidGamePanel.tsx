import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Gamepad2,
  Loader2,
  Play,
  RefreshCcw,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
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
  shizukuUid?: number | null;
};

type ScreenshotReport = {
  pngBase64: string;
};

type PointerSample = {
  x: number;
  y: number;
  startedAt: number;
};

const SELECTED_GAME_KEY = "baasAndroidSelectedGame";

interface AndroidGamePanelProps {
  virtualDisplayActive: boolean;
  virtualDisplayBusy: boolean;
  onToggleVirtualDisplay: (active: boolean, packageName?: string) => Promise<void>;
}

/** Live game preview and control backed by the privileged Shizuku virtual-display service. */
const AndroidGamePanel: React.FC<AndroidGamePanelProps> = ({
  virtualDisplayActive,
  virtualDisplayBusy,
  onToggleVirtualDisplay,
}) => {
  const [games, setGames] = useState<AndroidGame[]>([]);
  const [selectedPackage, setSelectedPackage] = useState("");
  const [shizukuInstalled, setShizukuInstalled] = useState(false);
  const [shizukuRunning, setShizukuRunning] = useState(false);
  const [shizukuGranted, setShizukuGranted] = useState(false);
  const [screenshot, setScreenshot] = useState("");
  const [loading, setLoading] = useState(true);
  const [launching, setLaunching] = useState(false);
  const pointerStart = useRef<PointerSample | null>(null);

  const selectedGame = useMemo(
    () => games.find((game) => game.packageName === selectedPackage) ?? games[0] ?? null,
    [games, selectedPackage]
  );

  const loadGames = useCallback(async () => {
    try {
      const report = await invoke<GameListReport>("android_list_games");
      setGames(report.games);
      setShizukuInstalled(report.shizukuInstalled);
      setShizukuRunning(report.shizukuRunning);
      setShizukuGranted(report.shizukuGranted);
      setSelectedPackage((current) => {
        const stored = window.localStorage.getItem(SELECTED_GAME_KEY) ?? "";
        const preferred = current || stored;
        return report.games.some((game) => game.packageName === preferred)
          ? preferred
          : (report.games[0]?.packageName ?? "");
      });
    } catch (error) {
      toast.error("Unable to inspect installed games", { description: String(error) });
    } finally {
      setLoading(false);
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
    if (!selectedGame || !virtualDisplayActive || !shizukuGranted) {
      setScreenshot("");
      return;
    }
    let cancelled = false;
    let timeoutId: number | undefined;
    const refresh = async () => {
      try {
        const report = await invoke<ScreenshotReport>("android_game_screenshot", {
          request: { packageName: selectedGame.packageName },
        });
        if (cancelled) return;
        if (report.pngBase64) setScreenshot(`data:image/png;base64,${report.pngBase64}`);
      } catch (error) {
        if (!cancelled) console.warn("Android game preview refresh failed", error);
      } finally {
        if (!cancelled) timeoutId = window.setTimeout(refresh, 1200);
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [selectedGame, shizukuGranted, virtualDisplayActive]);

  const selectGame = (packageName: string) => {
    setSelectedPackage(packageName);
    window.localStorage.setItem(SELECTED_GAME_KEY, packageName);
    setScreenshot("");
  };

  const launchGame = async () => {
    if (!selectedGame || launching) return;
    setLaunching(true);
    try {
      await invoke("android_launch_game", { request: { packageName: selectedGame.packageName } });
    } catch (error) {
      toast.error("Unable to open the game", { description: String(error) });
    } finally {
      setLaunching(false);
    }
  };

  const requestShizuku = async () => {
    try {
      await invoke("android_request_shizuku_permission");
      window.setTimeout(() => void loadGames(), 750);
    } catch (error) {
      toast.error("Shizuku setup needs attention", { description: String(error) });
    }
  };

  const toggleBackgroundDisplay = async () => {
    if (!virtualDisplayActive && !shizukuGranted) {
      await requestShizuku();
      return;
    }
    await onToggleVirtualDisplay(!virtualDisplayActive, selectedGame?.packageName);
  };

  const shizukuLabel = !shizukuInstalled
    ? "Install bundled Shizuku"
    : !shizukuRunning
      ? "Start Shizuku"
      : !shizukuGranted
        ? "Grant Shizuku"
        : "Shizuku ready";

  const imagePoint = (event: React.PointerEvent<HTMLImageElement>) => {
    const image = event.currentTarget;
    const bounds = image.getBoundingClientRect();
    return {
      x: Math.round(((event.clientX - bounds.left) / bounds.width) * image.naturalWidth),
      y: Math.round(((event.clientY - bounds.top) / bounds.height) * image.naturalHeight),
    };
  };

  const sendPointerGesture = async (event: React.PointerEvent<HTMLImageElement>) => {
    const start = pointerStart.current;
    pointerStart.current = null;
    if (!start || !selectedGame) return;
    const end = imagePoint(event);
    try {
      await invoke("android_game_gesture", {
        request: {
          packageName: selectedGame.packageName,
          x1: start.x,
          y1: start.y,
          x2: end.x,
          y2: end.y,
          durationMs: Math.max(1, Math.min(10_000, Date.now() - start.startedAt)),
        },
      });
    } catch (error) {
      toast.error("Game control failed", { description: String(error) });
    }
  };

  return (
    <section className="shrink-0 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="flex items-center justify-between gap-3 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          {selectedGame?.iconPngBase64 ? (
            <img
              src={`data:image/png;base64,${selectedGame.iconPngBase64}`}
              alt=""
              className="h-9 w-9 shrink-0 rounded-lg"
            />
          ) : (
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary-100 text-primary-600 dark:bg-primary-950/60 dark:text-primary-300">
              <Gamepad2 className="h-5 w-5" />
            </div>
          )}
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
              {loading ? "Finding installed games…" : selectedGame?.label || "Blue Archive not found"}
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              {virtualDisplayActive ? "Background game display" : "Local Android control"}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {games.length > 1 && (
            <select
              aria-label="Installed game"
              value={selectedGame?.packageName ?? ""}
              onChange={(event) => selectGame(event.target.value)}
              className="h-8 max-w-28 rounded-lg border border-slate-200 bg-white px-2 text-xs dark:border-slate-700 dark:bg-slate-800"
            >
              {games.map((game) => (
                <option key={game.packageName} value={game.packageName}>
                  {game.label}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            disabled={!selectedGame || launching}
            onClick={launchGame}
            aria-label="Open game"
            className="grid h-8 w-8 place-items-center rounded-lg bg-primary-600 text-white disabled:opacity-45"
          >
            {launching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          </button>
          <button
            type="button"
            disabled={!selectedGame || virtualDisplayBusy}
            onClick={() => void toggleBackgroundDisplay()}
            aria-label={virtualDisplayActive ? "Close background display" : "Open background display"}
            className={`grid h-8 w-8 place-items-center rounded-lg border transition disabled:opacity-45 ${
              virtualDisplayActive
                ? "border-emerald-500 bg-emerald-500 text-white"
                : "border-slate-200 text-slate-600 dark:border-slate-700 dark:text-slate-300"
            }`}
          >
            {virtualDisplayBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Smartphone className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {!shizukuGranted && (
        <button
          type="button"
          onClick={() => void requestShizuku()}
          className="flex w-full items-center justify-center gap-2 border-t border-sky-200 bg-sky-50 px-3 py-2.5 text-sm font-medium text-sky-800 dark:border-sky-900/60 dark:bg-sky-950/30 dark:text-sky-200"
        >
          <ShieldCheck className="h-4 w-4" /> {shizukuLabel} for non-root background mode
        </button>
      )}

      {screenshot ? (
        <div className="relative aspect-video overflow-hidden border-t border-slate-200 bg-black dark:border-slate-700">
          <img
            src={screenshot}
            alt={`${selectedGame?.label ?? "Game"} live display`}
            draggable={false}
            className="h-full w-full touch-none select-none object-contain"
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              pointerStart.current = { ...imagePoint(event), startedAt: Date.now() };
            }}
            onPointerUp={(event) => void sendPointerGesture(event)}
            onPointerCancel={() => {
              pointerStart.current = null;
            }}
          />
          <div className="pointer-events-none absolute right-2 top-2 rounded-full bg-black/65 px-2 py-1 text-[11px] font-medium text-white">
            Live · touch enabled
          </div>
        </div>
      ) : virtualDisplayActive ? (
        <div className="flex aspect-video items-center justify-center gap-2 border-t border-slate-200 bg-slate-950 text-sm text-slate-300 dark:border-slate-700">
          <RefreshCcw className="h-4 w-4 animate-spin" /> Waiting for the game display…
        </div>
      ) : null}
    </section>
  );
};

export default AndroidGamePanel;

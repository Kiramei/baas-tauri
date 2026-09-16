import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Play, RefreshCcw, Share2, X } from "lucide-react";
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

type StreamInfo = {
  videoStreamUrl: string;
  videoStreamToken: string;
};

const SELECTED_GAME_KEY = "baasAndroidSelectedGame";
const STREAM_FPS = 30;
const STREAM_BITRATE = 4_000_000;

const appendBytes = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left);
  joined.set(right, left.length);
  return joined;
};

const findSpsCodec = (payload: Uint8Array): string | null => {
  for (let index = 0; index + 7 < payload.length; index += 1) {
    const startCodeLength =
      payload[index] === 0 && payload[index + 1] === 0 && payload[index + 2] === 1
        ? 3
        : payload[index] === 0 &&
            payload[index + 1] === 0 &&
            payload[index + 2] === 0 &&
            payload[index + 3] === 1
          ? 4
          : 0;
    if (!startCodeLength) continue;
    const nal = index + startCodeLength;
    if ((payload[nal] & 0x1f) !== 7 || nal + 3 >= payload.length) continue;
    return `avc1.${[payload[nal + 1], payload[nal + 2], payload[nal + 3]]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("")}`;
  }
  return null;
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
  const [controlsVisible, setControlsVisible] = useState(false);
  const [takingOver, setTakingOver] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

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
    if (!selectedGame || !virtualDisplayActive || !shizukuGranted) {
      setPreviewReady(false);
      return;
    }
    let disposed = false;
    const abort = new AbortController();
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", { alpha: false });
    let decodedFrames = 0;
    const decoder = new VideoDecoder({
      output: (frame) => {
        if (!disposed && canvas && context) {
          if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
            canvas.width = frame.displayWidth;
            canvas.height = frame.displayHeight;
          }
          context.drawImage(frame, 0, 0, canvas.width, canvas.height);
          decodedFrames += 1;
          canvas.dataset.decodedFrames = String(decodedFrames);
          setPreviewReady(true);
        }
        frame.close();
      },
      error: (error) => {
        if (!disposed) console.warn("Android H.264 decoder failed", error);
      },
    });

    const consume = async () => {
      const info = await invoke<StreamInfo>("android_game_stream_info", {
        request: { fps: STREAM_FPS, bitrate: STREAM_BITRATE },
      });
      const url = new URL(info.videoStreamUrl);
      url.searchParams.set("fps", String(STREAM_FPS));
      url.searchParams.set("bitrate", String(STREAM_BITRATE));
      const response = await fetch(url, {
        headers: { "x-baas-token": info.videoStreamToken },
        cache: "no-store",
        signal: abort.signal,
      });
      if (!response.ok || !response.body) throw new Error(`Video stream HTTP ${response.status}`);
      const reader = response.body.getReader();
      let pending = new Uint8Array(0);
      let streamHeaderRead = false;
      let codecConfigured = false;
      let codecConfig = new Uint8Array(0);
      while (!disposed) {
        const { done, value } = await reader.read();
        if (done) break;
        pending = appendBytes(pending, value);
        if (!streamHeaderRead) {
          if (pending.length < 24) continue;
          const magic = new TextDecoder().decode(pending.subarray(0, 8));
          if (magic !== "BAASAVC1") throw new Error("Unsupported Android video stream format");
          const header = new DataView(pending.buffer, pending.byteOffset + 8, 16);
          if (canvas) {
            canvas.width = header.getUint32(0);
            canvas.height = header.getUint32(4);
          }
          pending = pending.slice(24);
          streamHeaderRead = true;
        }
        while (pending.length >= 16) {
          const record = new DataView(pending.buffer, pending.byteOffset, 16);
          const payloadLength = record.getUint32(0);
          if (pending.length < 16 + payloadLength) break;
          const timestamp = Number(record.getBigInt64(4));
          const flags = record.getUint32(12);
          const payload = pending.slice(16, 16 + payloadLength);
          pending = pending.slice(16 + payloadLength);
          if (flags & 4) return;
          if (flags & 1) {
            codecConfig = payload;
            const codec = findSpsCodec(payload);
            if (codec && !codecConfigured) {
              decoder.configure({ codec, optimizeForLatency: true });
              codecConfigured = true;
            }
            continue;
          }
          if (!codecConfigured || payload.length === 0) continue;
          const key = Boolean(flags & 2);
          if (!key && decoder.decodeQueueSize > 4) continue;
          decoder.decode(
            new EncodedVideoChunk({
              type: key ? "key" : "delta",
              timestamp,
              data: key && codecConfig.length ? appendBytes(codecConfig, payload) : payload,
            })
          );
        }
      }
    };
    const run = async () => {
      while (!disposed && !abort.signal.aborted) {
        try {
          await consume();
        } catch (error) {
          if (!disposed && !abort.signal.aborted) {
            console.warn("Android game stream failed", error);
          }
        }
        if (!disposed && !abort.signal.aborted) {
          await new Promise((resolve) => window.setTimeout(resolve, 750));
        }
      }
    };
    void run();
    return () => {
      disposed = true;
      abort.abort();
      if (decoder.state !== "closed") decoder.close();
      setPreviewReady(false);
    };
  }, [selectedGame, shizukuGranted, virtualDisplayActive]);

  useEffect(() => {
    if (!virtualDisplayActive) setControlsVisible(false);
  }, [virtualDisplayActive]);

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
    setControlsVisible(false);
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
      setControlsVisible(false);
    } catch (error) {
      toast.error("Unable to restart the game", { description: String(error) });
    } finally {
      setRestarting(false);
    }
  };

  const controlBusy = virtualDisplayBusy || takingOver || restarting;

  return (
    <section className="relative aspect-video w-full shrink-0 overflow-hidden rounded-xl bg-black shadow-sm ring-1 ring-slate-300/70 dark:ring-slate-700">
      {virtualDisplayActive && (
        <canvas
          ref={canvasRef}
          aria-label={`${selectedGame?.label ?? "Game"} live display`}
          className="absolute inset-0 block h-full w-full select-none object-cover"
        />
      )}

      <button
        type="button"
        aria-label={virtualDisplayActive ? "Show game controls" : "Start background game"}
        disabled={!selectedGame || virtualDisplayBusy}
        onClick={() => {
          if (virtualDisplayActive) setControlsVisible((visible) => !visible);
          else void startBackgroundDisplay();
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

      {virtualDisplayActive && controlsVisible && (
        <div
          className="absolute inset-0 z-20 bg-black/40 backdrop-blur-[1px]"
          onClick={() => setControlsVisible(false)}
        >
          <div className="absolute left-1/2 top-3 grid -translate-x-1/2 grid-cols-3 gap-3">
            <button
              type="button"
              aria-label="Close game"
              disabled={controlBusy}
              onClick={(event) => {
                event.stopPropagation();
                void closeBackgroundDisplay();
              }}
              className="grid h-11 w-11 place-items-center rounded-full bg-black/70 text-white shadow-lg disabled:opacity-50"
            >
              <X className="h-5 w-5" />
            </button>
            <button
              type="button"
              aria-label="Take over game"
              disabled={controlBusy}
              onClick={(event) => {
                event.stopPropagation();
                void takeOverGame();
              }}
              className="grid h-11 w-11 place-items-center rounded-full bg-primary-600 text-white shadow-lg disabled:opacity-50"
            >
              {takingOver ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <Share2 className="h-5 w-5" />
              )}
            </button>
            <button
              type="button"
              aria-label="Restart game"
              disabled={controlBusy}
              onClick={(event) => {
                event.stopPropagation();
                void restartGame();
              }}
              className="grid h-11 w-11 place-items-center rounded-full bg-black/70 text-white shadow-lg disabled:opacity-50"
            >
              {restarting ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <RefreshCcw className="h-5 w-5" />
              )}
            </button>
          </div>
        </div>
      )}
    </section>
  );
};

export default AndroidGamePanel;

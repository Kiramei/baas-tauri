import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

const FRAME_ENDPOINT = "http://127.0.0.1:8190/android/virtual-display/frame";
const FRAME_INTERVAL_MS = 350;

/** Displays JPEG snapshots produced by the app-owned Android virtual display. */
export const AndroidVirtualDisplayPreview = () => {
  const [frameUrl, setFrameUrl] = useState(() => `${FRAME_ENDPOINT}?t=${Date.now()}`);
  const [waiting, setWaiting] = useState(true);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const scheduleNextFrame = (delay = FRAME_INTERVAL_MS) => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setFrameUrl(`${FRAME_ENDPOINT}?t=${Date.now()}`);
    }, delay);
  };

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      <img
        src={frameUrl}
        alt="虚拟屏游戏画面"
        className="h-full w-full object-contain"
        draggable={false}
        onLoad={() => {
          setWaiting(false);
          scheduleNextFrame();
        }}
        onError={() => scheduleNextFrame(500)}
      />
      {waiting && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/30 text-white">
          <Loader2 className="h-8 w-8 animate-spin" />
          <span className="text-xs">正在连接游戏画面…</span>
        </div>
      )}
    </div>
  );
};

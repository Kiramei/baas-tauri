import React from "react";
import { useTranslation } from "react-i18next";
import { useWebSocketStore } from "@/store/WebsocketStore";
import { formatIsoToReadable } from "@/shared/GlobalUtilities";
import { IconTooltip } from "@/components/ui/Tooltip";

const normalizeAmount = (value: unknown): number | null => {
  if (typeof value !== "number" && (typeof value !== "string" || value.trim() === "")) {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
};

// A zero timestamp is the backend's unrecorded value, not a reading from 1970.
const isRecordedTime = (timestamp: unknown): timestamp is number =>
  typeof timestamp === "number" &&
  timestamp > 0 &&
  Number.isFinite(new Date(timestamp * 1000).getTime());

/** A quiet, horizontally scrollable account summary, rather than eight separate cards. */
const AssetsDisplay: React.FC<{ profileId: string }> = ({ profileId }) => {
  const { t } = useTranslation();
  const config = useWebSocketStore((state) => state.configStore[profileId]);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const pointerXRef = React.useRef<number | null>(null);
  const pointerYRef = React.useRef<number | null>(null);
  const frameRef = React.useRef<number | null>(null);
  const frameTimeRef = React.useRef(0);

  const stopScroll = React.useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    frameTimeRef.current = 0;
  }, []);
  const stopHover = React.useCallback(() => {
    pointerXRef.current = null;
    pointerYRef.current = null;
    stopScroll();
  }, [stopScroll]);

  const edgeSpeed = React.useCallback(() => {
    const element = scrollRef.current;
    if (!element || pointerXRef.current === null || pointerYRef.current === null || document.hidden)
      return 0;
    const overflow = element.scrollWidth - element.clientWidth;
    if (overflow <= 1 || element.clientWidth === 0) return 0;
    const bounds = element.getBoundingClientRect();
    if (
      bounds.width === 0 ||
      bounds.height === 0 ||
      pointerYRef.current < bounds.top ||
      pointerYRef.current > bounds.bottom
    )
      return 0;
    // The workspace can be scaled; pointer coordinates and scrollLeft use different units then.
    const x = ((pointerXRef.current - bounds.left) * element.clientWidth) / bounds.width;
    if (x < 0 || x > element.clientWidth) return 0;
    const edge = Math.min(40, element.clientWidth / 3);
    if (x < edge && element.scrollLeft > 1) return -(80 + 240 * (1 - x / edge));
    const rightDistance = element.clientWidth - x;
    if (rightDistance < edge && element.scrollLeft < overflow - 1) {
      return 80 + 240 * (1 - rightDistance / edge);
    }
    return 0;
  }, []);

  const tick = React.useCallback(
    function advance(timestamp: number) {
      const speed = edgeSpeed();
      const element = scrollRef.current;
      if (!element || speed === 0) {
        stopScroll();
        return;
      }
      const elapsed = Math.max(0, Math.min(50, timestamp - frameTimeRef.current));
      frameTimeRef.current = timestamp;
      element.scrollLeft += (speed * elapsed) / 1000;
      frameRef.current = requestAnimationFrame(advance);
    },
    [edgeSpeed, stopScroll]
  );

  const checkScroll = React.useCallback(() => {
    if (edgeSpeed() === 0) {
      stopScroll();
    } else if (frameRef.current === null) {
      frameTimeRef.current = performance.now();
      frameRef.current = requestAnimationFrame(tick);
    }
  }, [edgeSpeed, stopScroll, tick]);

  React.useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver(checkScroll);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    const onVisibility = () => {
      if (document.hidden) stopHover();
    };
    window.addEventListener("blur", stopHover);
    window.addEventListener("resize", checkScroll);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      observer.disconnect();
      window.removeEventListener("blur", stopHover);
      window.removeEventListener("resize", checkScroll);
      document.removeEventListener("visibilitychange", onVisibility);
      stopHover();
    };
  }, [checkScroll, stopHover]);

  React.useEffect(checkScroll, [config, profileId, checkScroll]);

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") {
      stopHover();
      return;
    }
    pointerXRef.current = event.clientX;
    pointerYRef.current = event.clientY;
    checkScroll();
  };

  const amount = (value: unknown, timestamp?: unknown) => {
    const numeric = normalizeAmount(value);
    return numeric !== null && (timestamp === undefined || isRecordedTime(timestamp))
      ? numeric.toLocaleString()
      : "—";
  };
  const fraction = (value: unknown, max: unknown, timestamp: unknown) => {
    const numeric = normalizeAmount(value);
    const numericMax = normalizeAmount(max);
    if (numeric === null || numericMax === null || !isRecordedTime(timestamp)) return "—";
    return `${numeric.toLocaleString()} / ${numericMax.toLocaleString()}`;
  };
  const holding = config?.create_item_holding_quantity as Record<string, unknown> | undefined;

  const assetItems = [
    {
      name: t("property.ap"),
      value: fraction(config?.ap?.count, config?.ap?.max, config?.ap?.time),
      time: config?.ap?.time,
    },
    {
      name: t("property.credits"),
      value: amount(config?.creditpoints?.count, config?.creditpoints?.time),
      time: config?.creditpoints?.time,
    },
    {
      name: t("property.pyroxene"),
      value: amount(config?.pyroxene?.count, config?.pyroxene?.time),
      time: config?.pyroxene?.time,
    },
    {
      name: t("property.coin.arena"),
      value: amount(config?.tactical_challenge_coin?.count, config?.tactical_challenge_coin?.time),
      time: config?.tactical_challenge_coin?.time,
    },
    {
      name: t("property.coin.commission"),
      value: amount(config?.bounty_coin?.count, config?.bounty_coin?.time),
      time: config?.bounty_coin?.time,
    },
    { name: t("property.keystone"), value: amount(holding?.Keystone) },
    { name: t("property.keystone.piece"), value: amount(holding?.["Keystone-Piece"]) },
    {
      name: t("property.pass"),
      value: fraction(config?._pass?.level, config?._pass?.max_level, config?._pass?.time),
      time: config?._pass?.time,
    },
  ];

  return (
    <div
      ref={scrollRef}
      data-assets-scroll
      onPointerEnter={onPointerMove}
      onPointerMove={onPointerMove}
      onPointerLeave={stopHover}
      onPointerCancel={stopHover}
      onBlurCapture={stopHover}
      onScroll={checkScroll}
      className="scrollbar-hide min-w-0 overflow-x-auto overscroll-x-contain"
    >
      <div className="grid w-full min-w-[800px] max-w-[960px] grid-cols-8 gap-x-4">
        {assetItems.map((item) => (
          <IconTooltip
            key={item.name}
            content={
              item.value !== "—" && isRecordedTime(item.time)
                ? formatIsoToReadable(new Date(item.time * 1000).toISOString())
                : undefined
            }
          >
            <div className="min-w-0">
              <div
                className="mb-1.5 truncate text-xs leading-4 text-muted-foreground"
                title={item.name}
              >
                {item.name}
              </div>
              <div
                className={`whitespace-nowrap text-[15px] font-medium leading-[22px] tabular-nums ${item.value === "—" ? "text-muted-foreground/60" : "text-foreground"}`}
              >
                {item.value}
              </div>
            </div>
          </IconTooltip>
        ))}
      </div>
    </div>
  );
};

export default AssetsDisplay;

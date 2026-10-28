import { useEffect, useRef, type ComponentProps } from "react";
import { useWebSocketStore } from "@/store/WebsocketStore";
import { useTranslation } from "react-i18next";
import { HeartbeatWatchdog } from "@/shared/HeartbeatWatchdog";
import { formatBackendConnectionStatus } from "@/shared/BackendConnectionStatus";
import {
  markBackendHeartbeatTimeout,
  useBackendConnectionStatus,
} from "@/shared/useBackendConnectionStatus";
import { cn } from "@/shared/cn";

/** One persistent logo badge also owns heartbeat recovery, including on small screens. */
export default function HeartbeatIndicator({ className, ...props }: ComponentProps<"span">) {
  const { t } = useTranslation();
  const status = useBackendConnectionStatus();
  const recoverTransport = useWebSocketStore((state) => state.recoverTransport);
  const watchdog = useRef(new HeartbeatWatchdog(0));

  useEffect(() => {
    let previousMode: string | undefined;
    let previousAuth: string | undefined;
    let previousHeartbeat: number | undefined;
    const updateWatchdog = () => {
      const state = useWebSocketStore.getState();
      if (
        state.transportMode !== previousMode ||
        state._auth_phase !== previousAuth ||
        state._heartbeat_time !== previousHeartbeat
      ) {
        markBackendHeartbeatTimeout(null);
        previousMode = state.transportMode;
        previousAuth = state._auth_phase;
        previousHeartbeat = state._heartbeat_time;
      }
      watchdog.current.update(
        state.transportMode,
        state._auth_phase,
        state._heartbeat_time,
        Date.now()
      );
    };
    updateWatchdog();
    const unsubscribe = useWebSocketStore.subscribe(updateWatchdog);
    const checkInterval = setInterval(async () => {
      updateWatchdog();
      if (watchdog.current.shouldRecover(Date.now())) {
        markBackendHeartbeatTimeout(useWebSocketStore.getState()._heartbeat_time);
        await recoverTransport();
      }
    }, 1000);
    return () => {
      clearInterval(checkInterval);
      unsubscribe();
    };
  }, [recoverTransport]);

  return (
    <span
      {...props}
      role="status"
      className={cn("size-1.5 shrink-0 rounded-full", className)}
      style={{
        ...props.style,
        backgroundColor: status === "connected" ? "#30a46c" : "var(--muted-foreground)",
      }}
    >
      <span className="sr-only">{formatBackendConnectionStatus(status, t)}</span>
    </span>
  );
}

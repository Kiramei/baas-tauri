import React, { useEffect, useState, useRef } from "react";
import { useWebSocketStore } from "@/store/WebsocketStore";
import { useTranslation } from "react-i18next";
import { HeartbeatWatchdog } from "@/shared/HeartbeatWatchdog";

interface IndicatorProps {
  onStateChanged: (state: boolean) => void;
}

/** Renders the indicator base component. */
const IndicatorBase: React.FC<IndicatorProps> = ({ onStateChanged }) => {
  const [connected, setConnected] = useState(true);
  const heartbeatTime = useWebSocketStore((s) => s._heartbeat_time);
  const transportMode = useWebSocketStore((s) => s.transportMode);
  const authPhase = useWebSocketStore((s) => s._auth_phase);
  const pipeConnected = useWebSocketStore(
    (s) =>
      s._auth_phase === "authenticated" &&
      Boolean(s.connections.provider) &&
      Boolean(s.connections.sync)
  );
  const recoverTransport = useWebSocketStore((s) => s.recoverTransport);
  const watchdog = useRef(new HeartbeatWatchdog(0));

  useEffect(() => {
    if (transportMode === "websocket") return;
    setConnected(pipeConnected);
    onStateChanged(pipeConnected);
  }, [onStateChanged, pipeConnected, transportMode]);

  useEffect(() => {
    watchdog.current.update(transportMode, authPhase, heartbeatTime, Date.now());
    if (transportMode !== "websocket") return;
    const healthy = authPhase === "authenticated" && heartbeatTime > 0;
    setConnected(healthy);
    onStateChanged(healthy);
  }, [authPhase, heartbeatTime, onStateChanged, transportMode]);

  useEffect(() => {
    const checkInterval = setInterval(async () => {
      const state = useWebSocketStore.getState();
      const now = Date.now();
      watchdog.current.update(state.transportMode, state._auth_phase, state._heartbeat_time, now);
      if (watchdog.current.shouldRecover(now)) {
        setConnected(false);
        onStateChanged(false);
        await recoverTransport();
      }
    }, 1000);
    return () => clearInterval(checkInterval);
  }, [onStateChanged, recoverTransport, transportMode]);

  const color = connected ? "#30a46c" : "var(--muted-foreground)";

  return (
    <div
      className="size-2 shrink-0 rounded-full"
      style={{
        backgroundColor: color,
      }}
    />
  );
};

/** Renders the heartbeat indicator component. */
const HeartbeatIndicator: React.FC = () => {
  const { t } = useTranslation();
  const [connected, setConnected] = useState(false);
  return (
    <div className="flex h-8 w-full flex-row items-center justify-start self-start overflow-hidden rounded-lg px-3">
      <IndicatorBase onStateChanged={setConnected} />
      <div className="ml-2 overflow-hidden whitespace-nowrap text-xs text-muted-foreground">
        {connected ? t("heartbeat.connected") : t("heartbeat.connecting")}
      </div>
      <div className="grow" />
    </div>
  );
};

export default HeartbeatIndicator;

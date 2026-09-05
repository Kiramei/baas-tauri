import React, { useEffect, useState, useRef } from "react";
import { motion } from "framer-motion";
import { useWebSocketStore } from "@/store/WebsocketStore";
import { useTranslation } from "react-i18next";
import { useUISetting } from "@/context/UISettingsProvider.tsx";

interface IndicatorProps {
  onStateChanged: (state: boolean) => void;
}

/** Renders the indicator base component. */
export const IndicatorBase: React.FC<IndicatorProps> = ({ onStateChanged }) => {
  const [connected, setConnected] = useState(true);
  const heartbeatTime = useWebSocketStore((s) => s._heartbeat_time);
  const transportMode = useWebSocketStore((s) => s.transportMode);
  const pipeConnected = useWebSocketStore(
    (s) =>
      s._auth_phase === "authenticated" &&
      Boolean(s.connections.provider) &&
      Boolean(s.connections.sync)
  );
  const recoverTransport = useWebSocketStore((s) => s.recoverTransport);
  const lastBeatRef = useRef<number>(0);

  useEffect(() => {
    lastBeatRef.current = Date.now();
  }, []);

  useEffect(() => {
    if (transportMode !== "pipe") return;
    setConnected(pipeConnected);
    onStateChanged(pipeConnected);
  }, [onStateChanged, pipeConnected, transportMode]);

  useEffect(() => {
    if (transportMode === "pipe") return;
    if (!heartbeatTime) return;
    lastBeatRef.current = Date.now();
    setConnected(true);
    onStateChanged(true);
  }, [heartbeatTime, onStateChanged, transportMode]);

  useEffect(() => {
    const checkInterval = setInterval(async () => {
      if (transportMode === "pipe") return;
      if (Date.now() - lastBeatRef.current > 5000) {
        setConnected(false);
        onStateChanged(false);
        await recoverTransport();
      }
    }, 1000);
    return () => clearInterval(checkInterval);
  }, [onStateChanged, recoverTransport, transportMode]);

  const color = connected ? "var(--color-primary-500)" : "var(--color-slate-500)";

  return (
    <div
      className="h-[12px] w-[12px] shrink-0 rounded-full"
      style={{
        backgroundColor: color,
        boxShadow: connected ? "0 0 10px var(--color-primary-400)" : "none",
      }}
    />
  );
};

/** Renders the heartbeat indicator component. */
const HeartbeatIndicator: React.FC<{ expanded?: boolean }> = ({ expanded = true }) => {
  const { t } = useTranslation();
  const [connected, setConnected] = useState(false);
  const lowPerformanceMode = useUISetting((settings) => settings.lowPerformanceMode);
  const textColor = connected ? "var(--color-primary-400)" : "var(--color-slate-400)";

  return (
    <div
      className={`flex w-full flex-row items-center self-start overflow-hidden rounded-xl bg-slate-100/50 dark:bg-slate-700/50 ${
        expanded ? "h-[36px] justify-start px-[12px]" : "h-[36px] justify-center p-0"
      }`}
    >
      <IndicatorBase onStateChanged={setConnected} />
      {lowPerformanceMode ? (
        <div
          className={`overflow-hidden whitespace-nowrap rounded-lg text-sm font-bold transition-[width,opacity,margin] duration-150 ${
            expanded ? "ml-4 w-auto opacity-100" : "ml-0 w-0 opacity-0"
          }`}
          style={{ color: textColor }}
        >
          {connected ? t("heartbeat.connected") : t("heartbeat.connecting")}
        </div>
      ) : (
        <motion.div
          className={`overflow-hidden whitespace-nowrap rounded-lg text-sm font-bold transition-[width,opacity,margin] duration-150 ${
            expanded ? "ml-4 w-auto opacity-100" : "ml-0 w-0 opacity-0"
          }`}
          animate={{
            color: textColor,
          }}
          transition={{ duration: 0.4 }}
        >
          {connected ? t("heartbeat.connected") : t("heartbeat.connecting")}
        </motion.div>
      )}
      {expanded && <div className="grow" />}
    </div>
  );
};

export default HeartbeatIndicator;

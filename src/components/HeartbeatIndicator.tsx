import React, { useEffect, useState, useRef } from "react";
import { motion } from "framer-motion";
import { useWebSocketStore } from "@/store/WebsocketStore";
import { useTranslation } from "react-i18next";
import { useUISettings } from "@/context/UISettingsProvider.tsx";

interface IndicatorProps {
  onStateChanged: (state: boolean) => void;
}

/** Renders the indicator base component. */
export const IndicatorBase: React.FC<IndicatorProps> = ({ onStateChanged }) => {
  const [connected, setConnected] = useState(true);
  const heartbeatTime = useWebSocketStore((s) => s._heartbeat_time);
  const init = useWebSocketStore((s) => s.init);
  const lastBeatRef = useRef<number>(0);

  useEffect(() => {
    lastBeatRef.current = Date.now();
  }, []);

  useEffect(() => {
    if (!heartbeatTime) return;
    lastBeatRef.current = Date.now();
    setConnected(true);
    onStateChanged(true);
  }, [heartbeatTime]);

  useEffect(() => {
    const checkInterval = setInterval(async () => {
      if (Date.now() - lastBeatRef.current > 5000) {
        setConnected(false);
        onStateChanged(false);
        await init();
      }
    }, 1000);
    return () => clearInterval(checkInterval);
  }, []);

  const color = connected ? "var(--color-primary-500)" : "var(--color-slate-500)";

  return (
    <div
      className="w-4 h-4 rounded-full mx-auto"
      style={{
        backgroundColor: color,
        boxShadow: connected ? "0 0 10px var(--color-primary-400)" : "none",
      }}
    />
  );
};

/** Renders the heartbeat indicator component. */
const HeartbeatIndicator = () => {
  const { t } = useTranslation();
  const [connected, setConnected] = useState(false);
  const { uiSettings } = useUISettings();
  const lowPerformanceMode = uiSettings.lowPerformanceMode;
  const textColor = connected ? "var(--color-primary-400)" : "var(--color-slate-400)";

  return (
    <div className="flex flex-row items-center justify-center p-4 bg-slate-100/50 dark:bg-slate-700/50 w-full rounded-xl self-start">
      <IndicatorBase onStateChanged={setConnected} />
      {lowPerformanceMode ? (
        <div className="ml-4 text-sm font-bold rounded-lg" style={{ color: textColor }}>
          {connected ? t("heartbeat.connected") : t("heartbeat.connecting")}
        </div>
      ) : (
        <motion.div
          className="ml-4 text-sm font-bold rounded-lg"
          animate={{
            color: textColor,
          }}
          transition={{ duration: 0.4 }}
        >
          {connected ? t("heartbeat.connected") : t("heartbeat.connecting")}
        </motion.div>
      )}
      <div className="grow" />
    </div>
  );
};

export default HeartbeatIndicator;

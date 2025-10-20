import React, {useEffect, useState, useRef} from "react";
import {motion} from "framer-motion";
import {useWebSocketStore} from "@/store/websocketStore.ts";
import {useTranslation} from "react-i18next";

interface IndicatorProps {
  onStateChanged: (state: boolean) => void;
}

export const HeartbeatIndicator: React.FC<IndicatorProps> = ({onStateChanged}) => {
  const [alive, setAlive] = useState(false);
  const [connected, setConnected] = useState(true);
  const heartbeatTime = useWebSocketStore((s) => s._heartbeat_time);
  const init = useWebSocketStore(s => s.init)
  const lastBeatRef = useRef<number>(Date.now());

  useEffect(() => {
    if (!heartbeatTime) return;
    lastBeatRef.current = Date.now();
    setAlive(true);
    setConnected(true);
    onStateChanged(true)
    const timer = setTimeout(() => setAlive(false), 300);
    return () => clearTimeout(timer);
  }, [heartbeatTime]);

  useEffect(() => {
    const checkInterval = setInterval(async () => {
      if (Date.now() - lastBeatRef.current > 5000) {
        setConnected(false);
        onStateChanged(false)
        await init();
      }
    }, 1000);
    return () => clearInterval(checkInterval);
  }, []);

  const color = connected
    ? alive
      ? "var(--color-primary-400)"
      : "var(--color-primary-500)"
    : "var(--color-slate-500)";

  return (
    <motion.div
      className="w-4 h-4 rounded-full mx-auto"
      animate={{
        scale: connected ? (alive ? 1.3 : 1) : 1,
        backgroundColor: color,
        boxShadow: connected
          ? alive
            ? "0 0 25px var(--color-primary-500)"
            : "0 0 10px var(--color-primary-400)"
          : "none",
      }}
      transition={{type: "spring", stiffness: 300, damping: 15}}
    />
  );
};

const HeartbeatDiv = () => {
  const {t} = useTranslation();
  const [connected, setConnected] = useState(false);

  return (
    <div
      className="flex flex-row items-center justify-center p-4 bg-slate-100/50 dark:bg-slate-700/50 w-full rounded-xl self-start">
      <HeartbeatIndicator onStateChanged={setConnected}/>
      <motion.div
        className="ml-4 text-sm font-bold rounded-lg"
        animate={{
          color: connected ? "var(--color-primary-400)" : "var(--color-slate-400)",
        }}
        transition={{duration: 0.4}}
      >
        {connected ? t("heartbeat.connected") : t("heartbeat.connecting")}
      </motion.div>
      <div className="flex-grow"/>
    </div>
  );
}

export default HeartbeatDiv;
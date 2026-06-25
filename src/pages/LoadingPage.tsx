import React, { useEffect, useRef } from "react";
import { TextGenerateEffect } from "@/components/ui/TextGenerateEffect.tsx";
import { useGlobalLogStore } from "@/store/GlobalLogStore";
import { formatIsoToReadableTime } from "@/shared/GlobalUtilities.ts";
import { motion } from "framer-motion";
import { useTheme } from "@/context/ThemeProvider.tsx";
import { useWebSocketStore } from "@/store/WebsocketStore";
import PasswordInputModal from "@/components/PasswordInputModal.tsx";
import { useUISettings } from "@/context/UISettingsProvider.tsx";

const baseUrl = import.meta.env.BASE_URL;

interface LoadingPageProps {
  message?: string;
}

const statusColorMap: Record<string, string> = {
  INFO: "var(--color-primary-500)",
  WARNING: "var(--color-yello-500)",
  ERROR: "var(--color-red-500)",
  CRITICAL: "var(--color-purple-500)",
};

export function AutoScrollTerminal({ children }: { children: React.ReactNode }) {
  const endRef = useRef<HTMLDivElement>(null);
  const { uiSettings } = useUISettings();

  useEffect(() => {
    endRef.current?.scrollIntoView({
      behavior: uiSettings.lowPerformanceMode ? "auto" : "smooth",
    });
  }, [children, uiSettings.lowPerformanceMode]);

  return (
    <div className="w-full h-full opacity-50 scrollbar-hide font-mono overflow-auto p-2 text-sm">
      {children}
      <div ref={endRef} />
    </div>
  );
}

const LoadingPage: React.FC<LoadingPageProps> = ({ message = "Loading..." }) => {
  const globalLogData = useGlobalLogStore((state) => state.globalLogData);
  const authPhase = useWebSocketStore((state) => state._auth_phase);
  const authError = useWebSocketStore((state) => state._auth_error);
  const serverInitialized = useWebSocketStore((state) => state._server_initialized);
  const serverVerified = useWebSocketStore((state) => state._server_verified);
  const startAuthFlow = useWebSocketStore((state) => state.startAuthFlow);
  const submitPassword = useWebSocketStore((state) => state.submitPassword);
  const { theme } = useTheme();
  const { uiSettings } = useUISettings();
  const lowPerformanceMode = uiSettings.lowPerformanceMode;

  useEffect(() => {
    if (authPhase === "idle" || authPhase === "revoked") {
      void startAuthFlow();
    }
  }, [authPhase, startAuthFlow]);

  const loadingMessage =
    authPhase === "control_connecting"
      ? "Connecting to the server..."
      : authPhase === "resuming"
        ? "Restoring authenticated session..."
        : authPhase === "initializing"
          ? "Initializing system password..."
          : authPhase === "authenticating"
            ? "Authenticating session..."
            : message;

  return (
    <>
      <div className="fixed inset-0 bg-slate-100 dark:bg-slate-950 overflow-hidden">
        <img
          src={
            theme === "light" ? `${baseUrl}images/bg-light.webp` : `${baseUrl}images/bg-dark.webp`
          }
          alt="Loading BG"
          className="w-full h-full object-cover object-center"
        />
      </div>

      <div className="fixed w-full h-full p-2">
        <div className="w-full h-full bg-slate-100/80 dark:bg-slate-900/80 backdrop-blur-[5px] rounded-md p-2 border-2 border-primary-500/70">
          <AutoScrollTerminal>
            {globalLogData.map((log, idx) => (
              <div className="flex" key={`${log.time}-${idx}`}>
                <div className="min-w-20 text-slate-600 dark:text-slate-400">
                  <TextGenerateEffect words={formatIsoToReadableTime(log.time)} mode="all" />
                </div>
                <div
                  className="min-w-20 flex justify-end mr-2 font-bold"
                  style={{ color: statusColorMap[log.level] }}
                >
                  <TextGenerateEffect words={log.level} mode="all" />
                </div>
                <motion.div
                  className="flex-1 border-l-3 pl-4"
                  style={{
                    borderColor: statusColorMap[log.level],
                    whiteSpace: "pre-wrap",
                    borderLeftWidth: log.level === "INFO" ? "3px" : "5px",
                    color: log.level === "INFO" ? "inherit" : statusColorMap[log.level],
                    fontWeight: log.level === "INFO" ? "inherit" : "bold",
                  }}
                  initial={lowPerformanceMode ? false : { opacity: 0, filter: "blur(10px)" }}
                  animate={{ opacity: 1, filter: "blur(0px)" }}
                  transition={{ duration: lowPerformanceMode ? 0 : 0.5 }}
                >
                  {log.message}
                </motion.div>
              </div>
            ))}
          </AutoScrollTerminal>
        </div>
      </div>

      <div className="z-10 flex flex-col items-center justify-center w-full h-full">
        <div
          className="fixed"
          style={{
            marginTop: "calc(var(--spacing) * -15)",
          }}
        >
          <img
            src={`${baseUrl}images/logo.png`}
            alt="App Logo"
            className="w-36 h-36 mb-6 fixed rounded-full drop-shadow-[0_0_80px_rgba(0,215,255,0.8)] dark:drop-shadow-[0_0_80px_rgba(59,130,246,0.8)]"
          />

          <div
            className="animate-spin rounded-full h-40 w-40 border-t-4 border-b-4 drop-shadow-[0_0_10px_rgba(255,255,246,0.8)]
              border-primary-500 dark:border-primary-300 mb-6 dark:drop-shadow-[0_0_10px_rgba(255,255,246,0.8)]"
            style={{
              marginTop: "calc(var(--spacing) * -2)",
              marginLeft: "calc(var(--spacing) * -2)",
            }}
          />
        </div>

        <p
          className="text-lg font-bold text-slate-500 dark:text-slate-200 absolute mt-40 py-1 px-4 rounded-lg font-mono
              bg-[#eeeeeeee] dark:bg-[#0000002f] backdrop-blur-[5px] border-[#90a1b977] dark:border-slate-700 border"
        >
          {loadingMessage}
        </p>
      </div>

      <PasswordInputModal
        open={
          authPhase === "server_verified" ||
          authPhase === "waiting_password" ||
          authPhase === "initializing" ||
          authPhase === "authenticating"
        }
        setupMode={!serverInitialized}
        serverVerified={serverVerified}
        submitting={authPhase === "initializing" || authPhase === "authenticating"}
        error={authError}
        onConfirm={async (password: string) => {
          await submitPassword(password);
        }}
      />
    </>
  );
};

export default LoadingPage;

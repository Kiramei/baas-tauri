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

const androidPasswordKey = "baasAndroidAutoPassword";

const getAndroidAutoPassword = () => {
  const stored = window.localStorage.getItem(androidPasswordKey);
  if (stored) return stored;
  const next = globalThis.crypto?.randomUUID
    ? `baas-android-${globalThis.crypto.randomUUID()}`
    : `baas-android-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  window.localStorage.setItem(androidPasswordKey, next);
  return next;
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
  const logoRef = useRef<HTMLImageElement>(null);
  const globalLogData = useGlobalLogStore((state) => state.globalLogData);
  const authPhase = useWebSocketStore((state) => state._auth_phase);
  const authError = useWebSocketStore((state) => state._auth_error);
  const serverInitialized = useWebSocketStore((state) => state._server_initialized);
  const serverVerified = useWebSocketStore((state) => state._server_verified);
  const allDataInitialized = useWebSocketStore((state) => state._all_data_initialized);
  const initiating = useWebSocketStore((state) => state._initiating);
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

  useEffect(() => {
    if (!__WITH_ANDROID__) return;
    if (authPhase !== "waiting_password") return;
    void submitPassword(getAndroidAutoPassword());
  }, [authPhase, submitPassword]);

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
            width: "160px",
            height: "160px",
          }}
        >
          <img
            ref={logoRef}
            src={`${baseUrl}images/logo.png`}
            alt="App Logo"
            className="rounded-full drop-shadow-[0_0_80px_rgba(0,215,255,0.8)] dark:drop-shadow-[0_0_80px_rgba(59,130,246,0.8)]"
            style={{
              position: "absolute",
              top: "8px",
              left: "8px",
              width: "144px",
              height: "144px",
              maxWidth: "144px",
              objectFit: "contain",
            }}
          />

          <div
            className="animate-spin rounded-full border-t-4 border-b-4 drop-shadow-[0_0_10px_rgba(255,255,246,0.8)]
              border-primary-500 dark:border-primary-300 mb-6 dark:drop-shadow-[0_0_10px_rgba(255,255,246,0.8)]"
            style={{
              width: "160px",
              height: "160px",
            }}
          />
        </div>

        <p
          className="text-lg font-bold text-slate-500 dark:text-slate-200 absolute mt-40 py-1 px-4 rounded-lg font-mono
              bg-[#eeeeeeee] dark:bg-[#0000002f] backdrop-blur-[5px] border-[#90a1b977] dark:border-slate-700 border"
        >
          {loadingMessage}
        </p>

        {__WITH_ANDROID__ && (
          <div className="absolute bottom-6 left-4 right-4 mx-auto max-w-xl rounded-md border border-primary-400/40 bg-slate-950/65 p-4 text-sm text-slate-100 shadow-xl backdrop-blur">
            <div className="mb-2 font-semibold text-primary-200">Android startup</div>
            <div className="grid gap-1.5 font-mono text-xs">
              <div>Python backend: {serverVerified ? "connected" : "starting"}</div>
              <div>Auth: {serverInitialized ? authPhase : "initial setup"}</div>
              <div>Configuration sync: {initiating ? "running" : allDataInitialized ? "done" : "waiting"}</div>
              <div>OCR runtime: bundled desktop binary is unavailable on Android; continuing in service mode</div>
            </div>
          </div>
        )}
      </div>

      {!__WITH_ANDROID__ && (
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
      )}
    </>
  );
};

export default LoadingPage;

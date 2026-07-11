import React, { useEffect, useRef, useState } from "react";
import { useGlobalLogStore } from "@/store/GlobalLogStore";
import { formatIsoToReadableTime } from "@/shared/GlobalUtilities.ts";
import { useTheme } from "@/context/ThemeProvider.tsx";
import { resolveHttpBase, useBackendStore } from "@/store/BackendStore";
import { useUISettings } from "@/context/UISettingsProvider.tsx";

const baseUrl = import.meta.env.BASE_URL;
const ANDROID_TERMINAL_DELAY_MS = 2_000;
const AndroidStartupTerminal = React.lazy(() => import("@/components/AndroidStartupTerminal"));
const PasswordInputModal = __WITH_WEBUI__
  ? React.lazy(() => import("@/components/PasswordInputModal.tsx"))
  : null;

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

/** Returns the get android auto password result. */
const getAndroidAutoPassword = () => {
  const stored = window.localStorage.getItem(androidPasswordKey);
  if (stored) return stored;
  const next = globalThis.crypto?.randomUUID
    ? `baas-android-${globalThis.crypto.randomUUID()}`
    : `baas-android-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  window.localStorage.setItem(androidPasswordKey, next);
  return next;
};

/** Renders the auto scroll terminal component. */
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

const androidLevelMap: Record<string, string> = {
  INFO: "I",
  WARNING: "W",
  ERROR: "F",
  CRITICAL: "C",
  DEBUG: "D",
};

/** Returns the format startup log chunk result. */
const formatStartupLogChunk = (log: { time: string; level: string; message: string }) => {
  const level = androidLevelMap[String(log.level).toUpperCase()] ?? String(log.level).slice(0, 1);
  return `${formatIsoToReadableTime(log.time)} ${level} ${log.message}`;
};

/** Handles the keep recent log lines workflow. */
const keepRecentLogLines = (text: string, maxLines = 120) => {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return lines.slice(-maxLines).join("\n");
};

/** Renders the loading page component. */
const LoadingPage: React.FC<LoadingPageProps> = ({ message = "Loading..." }) => {
  const logoRef = useRef<HTMLImageElement>(null);
  const androidLogCursorRef = useRef(0);
  const androidAuthResetAttemptedRef = useRef(false);
  const globalLogData = useGlobalLogStore((state) => state.globalLogData);
  const [androidStartupLogChunk, setAndroidStartupLogChunk] = useState("");
  const [androidTerminalReady, setAndroidTerminalReady] = useState(!__WITH_ANDROID__);
  const authPhase = useBackendStore((state) => state._auth_phase);
  const authError = useBackendStore((state) => state._auth_error);
  const serverInitialized = useBackendStore((state) => state._server_initialized);
  const serverVerified = useBackendStore((state) => state._server_verified);
  const allDataInitialized = useBackendStore((state) => state._all_data_initialized);
  const initiating = useBackendStore((state) => state._initiating);
  const startAuthFlow = useBackendStore((state) => state.startAuthFlow);
  const submitPassword = useBackendStore((state) => state.submitPassword);
  const { theme } = useTheme();

  useEffect(() => {
    if (!__WITH_ANDROID__) return;
    const timer = setTimeout(() => {
      setAndroidTerminalReady(true);
    }, ANDROID_TERMINAL_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (authPhase === "idle" || authPhase === "revoked") {
      const delay = __WITH_ANDROID__ ? 400 : 0;
      const timer = setTimeout(() => {
        void startAuthFlow();
      }, delay);
      return () => clearTimeout(timer);
    }
  }, [authPhase, startAuthFlow]);

  useEffect(() => {
    if (!__WITH_ANDROID__) return;
    if (authPhase !== "waiting_password") return;
    void submitPassword(getAndroidAutoPassword());
  }, [authPhase, submitPassword]);

  useEffect(() => {
    if (!__WITH_ANDROID__) return;
    if (androidAuthResetAttemptedRef.current) return;
    if (!authError?.includes("Password proof verification failed")) return;
    androidAuthResetAttemptedRef.current = true;
    const password = getAndroidAutoPassword();
    void fetch(`${resolveHttpBase()}/android/reset-auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    }).finally(() => {
      void startAuthFlow();
    });
  }, [authError, startAuthFlow]);

  useEffect(() => {
    if (!__WITH_ANDROID__) return;
    const previousLength = androidLogCursorRef.current;
    if (globalLogData.length < previousLength) {
      androidLogCursorRef.current = 0;
    }
    const nextLogs = globalLogData.slice(androidLogCursorRef.current);
    if (!nextLogs.length) return;
    androidLogCursorRef.current = globalLogData.length;
    const chunk = nextLogs.map(formatStartupLogChunk).join("\n");
    setAndroidStartupLogChunk((current) =>
      keepRecentLogLines(`${current}${current ? "\n" : ""}${chunk}`)
    );
  }, [globalLogData]);

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
        {!__WITH_ANDROID__ && (
          <img
            src={
              theme === "light" ? `${baseUrl}images/bg-light.webp` : `${baseUrl}images/bg-dark.webp`
            }
            alt="Loading BG"
            className="w-full h-full object-cover object-center"
          />
        )}
      </div>

      <div className="fixed w-full h-full p-2">
        <div className="w-full h-full bg-slate-100/80 dark:bg-slate-900/80 backdrop-blur-[5px] rounded-md p-2 border-2 border-primary-500/70">
          {__WITH_ANDROID__ ? (
            <React.Suspense
              fallback={
                <pre className="h-full w-full overflow-hidden whitespace-pre-wrap p-2 font-mono text-xs leading-5 text-slate-200">
                  {androidStartupLogChunk || "Waiting for backend startup logs..."}
                </pre>
              }
            >
              {androidTerminalReady ? (
                <AndroidStartupTerminal
                  text={androidStartupLogChunk || "Waiting for backend startup logs..."}
                  theme={theme}
                />
              ) : (
                <pre className="h-full w-full overflow-hidden whitespace-pre-wrap p-2 font-mono text-xs leading-5 text-slate-200">
                  {androidStartupLogChunk || "Waiting for backend startup logs..."}
                </pre>
              )}
            </React.Suspense>
          ) : (
            <AutoScrollTerminal>
              {globalLogData.map((log, idx) => (
                <div className="flex" key={`${log.time}-${idx}`}>
                  <div className="min-w-20 text-slate-600 dark:text-slate-400">
                    {formatIsoToReadableTime(log.time)}
                  </div>
                  <div
                    className="min-w-20 flex justify-end mr-2 font-bold"
                    style={{ color: statusColorMap[log.level] }}
                  >
                    {log.level}
                  </div>
                  <div
                    className="flex-1 border-l-3 pl-4"
                    style={{
                      borderColor: statusColorMap[log.level],
                      whiteSpace: "pre-wrap",
                      borderLeftWidth: log.level === "INFO" ? "3px" : "5px",
                      color: log.level === "INFO" ? "inherit" : statusColorMap[log.level],
                      fontWeight: log.level === "INFO" ? "inherit" : "bold",
                    }}
                  >
                    {log.message}
                  </div>
                </div>
              ))}
            </AutoScrollTerminal>
          )}
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
          <div className="absolute bottom-6 left-4 right-4 mx-auto max-w-xl rounded-md border border-primary-400/40 bg-slate-950/65 p-3 text-sm text-slate-100 shadow-xl backdrop-blur">
            <div className="mb-2 font-semibold text-primary-200">Android startup</div>
            <div className="grid gap-1 font-mono text-xs">
              <div>Python backend: {serverVerified ? "connected" : "starting"}</div>
              <div>Auth: {serverInitialized ? authPhase : "initial setup"}</div>
              <div>
                Configuration sync:{" "}
                {initiating ? "running" : allDataInitialized ? "done" : "waiting"}
              </div>
            </div>
          </div>
        )}
      </div>

      {__WITH_WEBUI__ && PasswordInputModal && (
        <React.Suspense fallback={null}>
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
        </React.Suspense>
      )}
    </>
  );
};

export default LoadingPage;

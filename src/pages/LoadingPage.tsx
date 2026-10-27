import React, { useEffect, useRef, useState } from "react";
import { useGlobalLogStore } from "@/store/GlobalLogStore";
import { formatIsoToReadableTime } from "@/shared/GlobalUtilities.ts";
import { useTheme } from "@/context/ThemeProvider.tsx";
import { resolveHttpBase, useWebSocketStore } from "@/store/WebsocketStore";
import { useUISetting } from "@/context/UISettingsProvider.tsx";
import { getAndroidAutoPassword } from "@/shared/AndroidAuth";
import StartupShellHandoff from "@/components/StartupShellHandoff";

const baseUrl = import.meta.env.BASE_URL;
const ANDROID_TERMINAL_DELAY_MS = 2_000;
const AndroidStartupTerminal = React.lazy(() => import("@/components/AndroidStartupTerminal"));
const AndroidInstallStepper = React.lazy(() => import("@/android/components/AndroidInstallStepper"));
const PasswordInputModal = React.lazy(() => import("@/components/PasswordInputModal.tsx"));

interface LoadingPageProps {
  message?: string;
}

const statusColorMap: Record<string, string> = {
  INFO: "var(--muted-foreground)",
  WARNING: "var(--color-yellow-500)",
  ERROR: "var(--color-red-500)",
  CRITICAL: "var(--color-purple-500)",
};

/** Renders the auto scroll terminal component. */
export function AutoScrollTerminal({ children }: { children: React.ReactNode }) {
  const endRef = useRef<HTMLDivElement>(null);
  const lowPerformanceMode = useUISetting((settings) => settings.lowPerformanceMode);

  useEffect(() => {
    endRef.current?.scrollIntoView({
      behavior: lowPerformanceMode ? "auto" : "smooth",
    });
  }, [children, lowPerformanceMode]);

  return (
    <div className="w-full h-full scrollbar-hide font-mono overflow-auto p-4 text-xs leading-5 text-muted-foreground">
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

const formatStartupLogChunk = (log: { time: string; level: string; message: string }) => {
  const level = androidLevelMap[String(log.level).toUpperCase()] ?? String(log.level).slice(0, 1);
  return `${formatIsoToReadableTime(log.time)} ${level} ${log.message}`;
};

const keepRecentLogLines = (text: string, maxLines = 120) => {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return lines.slice(-maxLines).join("\n");
};

/** Renders the loading page component. */
const LoadingPage: React.FC<LoadingPageProps> = ({ message = "Loading..." }) => {
  const androidLogCursorRef = useRef(0);
  const androidAuthResetAttemptedRef = useRef(false);
  const globalLogData = useGlobalLogStore((state) => state.globalLogData);
  const [androidStartupLogChunk, setAndroidStartupLogChunk] = useState("");
  const [androidTerminalReady, setAndroidTerminalReady] = useState(!__WITH_ANDROID__);
  const authPhase = useWebSocketStore((state) => state._auth_phase);
  const authError = useWebSocketStore((state) => state._auth_error);
  const serverInitialized = useWebSocketStore((state) => state._server_initialized);
  const serverVerified = useWebSocketStore((state) => state._server_verified);
  const allDataInitialized = useWebSocketStore((state) => state._all_data_initialized);
  const initiating = useWebSocketStore((state) => state._initiating);
  const startAuthFlow = useWebSocketStore((state) => state.startAuthFlow);
  const submitPassword = useWebSocketStore((state) => state.submitPassword);
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
      const delay = 0;
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

  if (__WITH_ANDROID__) return <React.Suspense fallback={null}><StartupShellHandoff><AndroidInstallStepper text={androidStartupLogChunk} theme={theme} /></StartupShellHandoff></React.Suspense>;

  return (
    <>
      <div className="absolute inset-0 flex min-h-0 flex-col overflow-hidden bg-background text-foreground">
        <div className="flex min-h-44 flex-1 flex-col items-center justify-center gap-5 px-6 py-10">
          <img
            src={`${baseUrl}images/logo.png`}
            alt="BAAS"
            className="h-14 w-14 rounded-2xl object-contain"
          />
          <div className="max-w-lg space-y-2 text-center">
            <h1 className="text-xl font-semibold tracking-tight">BAAS</h1>
            <p
              className="flex items-center justify-center gap-2 text-sm text-muted-foreground"
              role="status"
            >
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
              {loadingMessage}
            </p>
          </div>
          {__WITH_ANDROID__ && (
            <div className="w-full max-w-md rounded-xl border border-border bg-card p-4 text-sm">
              <div className="mb-2 font-medium">Android startup</div>
              <div className="grid gap-1 text-xs text-muted-foreground">
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

        <div className="mx-4 mb-4 h-44 min-h-24 shrink-0 overflow-hidden rounded-xl border border-border bg-secondary/30 sm:mx-8 sm:mb-6">
          {__WITH_ANDROID__ ? (
            <React.Suspense
              fallback={
                <pre className="h-full w-full overflow-hidden whitespace-pre-wrap p-4 font-mono text-xs leading-5 text-muted-foreground">
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
                <pre className="h-full w-full overflow-hidden whitespace-pre-wrap p-4 font-mono text-xs leading-5 text-muted-foreground">
                  {androidStartupLogChunk || "Waiting for backend startup logs..."}
                </pre>
              )}
            </React.Suspense>
          ) : (
            <AutoScrollTerminal>
              {globalLogData.map((log, idx) => (
                <div className="flex gap-3" key={`${log.time}-${idx}`}>
                  <div className="w-18 shrink-0 tabular-nums">
                    {formatIsoToReadableTime(log.time)}
                  </div>
                  <div className="w-14 shrink-0" style={{ color: statusColorMap[log.level] }}>
                    {log.level}
                  </div>
                  <div
                    className="min-w-0 flex-1 whitespace-pre-wrap break-words"
                    style={{ color: log.level === "INFO" ? "inherit" : statusColorMap[log.level] }}
                  >
                    {log.message}
                  </div>
                </div>
              ))}
            </AutoScrollTerminal>
          )}
        </div>
      </div>

      {!__WITH_ANDROID__ && (
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

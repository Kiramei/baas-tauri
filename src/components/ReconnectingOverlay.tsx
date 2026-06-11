import React, { useEffect } from "react";
import { motion } from "framer-motion";
import { PasswordInputModal } from "@/pages/LoadingPage.tsx";
import { useWebSocketStore } from "@/store/WebsocketStore.ts";

const reconnectingMessages: Record<string, string> = {
  idle: "Opening secure control channel...",
  control_connecting: "Connecting to the backend...",
  server_verified: "Server verified. Waiting for authentication...",
  waiting_password: "Authentication required to continue.",
  resuming: "Restoring encrypted session...",
  initializing: "Initializing authentication...",
  authenticating: "Authenticating session...",
  revoked: "Re-establishing backend connection...",
};

const ReconnectingOverlay: React.FC = () => {
  const authPhase = useWebSocketStore((state) => state._auth_phase);
  const authError = useWebSocketStore((state) => state._auth_error);
  const serverInitialized = useWebSocketStore((state) => state._server_initialized);
  const serverVerified = useWebSocketStore((state) => state._server_verified);
  const startAuthFlow = useWebSocketStore((state) => state.startAuthFlow);
  const submitPassword = useWebSocketStore((state) => state.submitPassword);
  const requiresPassword =
    authPhase === "server_verified" ||
    authPhase === "waiting_password" ||
    authPhase === "initializing" ||
    authPhase === "authenticating";

  useEffect(() => {
    if (authPhase === "idle" || authPhase === "revoked") {
      void startAuthFlow();
    }
  }, [authPhase, startAuthFlow]);

  return (
    <>
      <motion.div
        className="fixed inset-0 z-100 overflow-hidden bg-slate-950/55 backdrop-blur-[2px] backdrop-saturate-150"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.24, ease: "easeOut" }}
        aria-live="polite"
        role="status"
      >
        <div className="relative z-10 flex h-full w-full items-center justify-center px-6">
          <div className="flex max-w-xl flex-col items-center text-center text-white">
            <div className="relative mb-8 h-36 w-36">
              <div className="absolute inset-0 rounded-full border border-cyan-200/25" />
              <div className="absolute inset-3 animate-spin rounded-full border-2 border-transparent border-t-cyan-200 border-r-emerald-200 shadow-[0_0_42px_rgba(34,211,238,0.35)]" />
              <div className="absolute inset-8 animate-[spin_2.4s_linear_infinite_reverse] rounded-full border border-transparent border-b-sky-300 border-l-white/70" />
              <div className="absolute inset-12 rounded-full bg-white/10 shadow-[inset_0_0_22px_rgba(255,255,255,0.3),0_0_50px_rgba(45,212,191,0.45)] backdrop-blur-md" />
              <div className="absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-cyan-100 shadow-[0_0_26px_rgba(165,243,252,1)]" />
            </div>

            <div className="mb-3 rounded-full border border-white/15 bg-white/10 px-4 py-1 text-xs font-semibold uppercase tracking-[0.42em] text-cyan-100 shadow-[0_0_30px_rgba(14,165,233,0.18)] backdrop-blur-md">
              Backend Link Interrupted
            </div>
            <h1 className="text-4xl font-black tracking-[0.22em] text-white drop-shadow-[0_0_28px_rgba(125,211,252,0.55)] sm:text-6xl">
              CONNECTING
            </h1>
            <p className="mt-5 text-sm font-medium text-cyan-50/85 sm:text-base">
              {reconnectingMessages[authPhase] ?? "Synchronizing connection state..."}
            </p>
            {authError && !requiresPassword && (
              <p className="mt-3 max-w-md rounded-full border border-white/10 bg-black/20 px-4 py-2 text-xs text-white/65">
                {authError}
              </p>
            )}
            <div className="mt-7 flex gap-2">
              {[0, 1, 2].map((index) => (
                <motion.span
                  key={index}
                  className="h-2 w-9 rounded-full bg-cyan-100/80 shadow-[0_0_18px_rgba(125,211,252,0.9)]"
                  animate={{ opacity: [0.25, 1, 0.25], scaleX: [0.65, 1.2, 0.65] }}
                  transition={{
                    duration: 1.1,
                    repeat: Infinity,
                    delay: index * 0.18,
                    ease: "easeInOut",
                  }}
                />
              ))}
            </div>
          </div>
        </div>
      </motion.div>

      <PasswordInputModal
        open={requiresPassword}
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

export default ReconnectingOverlay;

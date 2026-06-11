import React, { useEffect, useRef, useState } from "react";
import { TextGenerateEffect } from "../components/ui/TextGenerateEffect.tsx";
import { useGlobalLogStore } from "@/store/GlobalLogStore.ts";
import { formatIsoToReadableTime } from "@/shared/GlobalUtilities.ts";
import { motion } from "framer-motion";
import { useTheme } from "@/context/ThemeProvider.tsx";
import { useWebSocketStore } from "../store/WebsocketStore.ts";
import { useTranslation } from "react-i18next";
import { Info, KeyRound, ShieldCheck } from "lucide-react";
import { FormInput } from "@/components/ui/FormInput.tsx";
import CButton from "@/components/ui/CButton.tsx";
import { FormSelect } from "@/components/ui/FormSelect.tsx";
import i18n from "i18next";
import { loadLocale } from "@/shared/I18nTranslator.ts";
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

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [children]);

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
                  initial={{ opacity: 0, filter: "blur(10px)" }}
                  animate={{ opacity: 1, filter: "blur(0px)" }}
                  transition={{ duration: 0.5 }}
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

const overlayCls =
  "fixed inset-0 flex items-center justify-center bg-black/50 z-[120] backdrop-blur-sm";

export const PasswordInputModal: React.FC<{
  open: boolean;
  setupMode: boolean;
  serverVerified: boolean;
  submitting: boolean;
  error: string | null;
  onConfirm: (password: string) => void | Promise<void>;
}> = ({ open, setupMode, serverVerified, submitting, error, onConfirm }) => {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [localError, setLocalError] = useState("");
  const { setUiSettings } = useUISettings();

  useEffect(() => {
    if (!open) {
      setPassword("");
      setConfirmPassword("");
      setLocalError("");
    }
  }, [open]);

  if (!open) return null;

  const handleConfirm = async () => {
    if (!password.trim()) {
      setLocalError("Please enter the key!");
      return;
    }
    if (setupMode && password !== confirmPassword) {
      setLocalError("The two passwords do not match!");
      return;
    }
    setLocalError("");
    await onConfirm(password.trim());
  };

  const handleLanguageChange = (value: string) => {
    loadLocale(value).then(() => {
      setUiSettings((state) => ({ ...state, lang: value }));
    });
  };

  return (
    <div className={overlayCls}>
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 10 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
        className="w-110 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-2xl p-6"
      >
        <form onSubmit={(e) => e.preventDefault()}>
          <div className="flex items-center gap-3 mb-4">
            <div className="rounded-full bg-primary-100 dark:bg-primary-900/40 text-primary-600 p-3">
              {serverVerified ? (
                <ShieldCheck className="w-6 h-6" />
              ) : (
                <KeyRound className="w-6 h-6" />
              )}
            </div>

            <div>
              <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                {setupMode ? t("auth.initializeKeyTitle") : t("auth.enterKeyTitle")}
              </h2>

              <p className="text-sm text-slate-500 dark:text-slate-400">
                {serverVerified
                  ? setupMode
                    ? t("auth.setKeySubtitle")
                    : t("auth.validateKeySubtitle")
                  : t("auth.verifyingServerIdentity")}
              </p>
            </div>

            <div className="grow" />

            <FormSelect
              value={i18n.language}
              onChange={handleLanguageChange}
              options={[
                { value: "en", label: t("english") },
                { value: "zh", label: t("chinese") },
                { value: "ja", label: t("japanese") },
                { value: "ko", label: t("korean") },
                { value: "de", label: t("deutsch") },
                { value: "ru", label: t("russian") },
                { value: "fr", label: t("french") },
              ]}
              className="float-right"
            />
          </div>

          <div className="mb-4">
            <input type="text" name="username" autoComplete="username" className="hidden" />

            <FormInput
              label={setupMode ? t("auth.newPasswordLabel") : t("auth.passwordLabel")}
              type="password"
              value={password}
              id="baas-key-input"
              autoComplete="current-password"
              onKeyDown={async (e) => {
                if (e.code === "Enter") {
                  if (setupMode) return;
                  e.preventDefault();
                  await handleConfirm();
                }
              }}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={
                setupMode ? t("auth.setPasswordPlaceholder") : t("auth.enterPasswordPlaceholder")
              }
              disabled={!serverVerified || submitting}
            />
          </div>

          {setupMode && (
            <div className="mb-4">
              <FormInput
                label={t("auth.confirmPasswordLabel")}
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                placeholder={t("auth.setPasswordPlaceholder")}
                disabled={!serverVerified || submitting}
                autoComplete="off"
              />
            </div>
          )}

          {(localError || error) && (
            <p className="mb-4 text-xs text-red-500 dark:text-red-400">{localError || error}</p>
          )}

          <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 mb-4">
            <Info className="w-4 h-4 text-primary-500" />
            <span>{setupMode ? t("auth.rememberKeyTip") : t("auth.forgotKeyTip")}</span>
          </div>

          <div className="flex justify-end gap-2">
            <CButton onClick={handleConfirm} disabled={!serverVerified || submitting}>
              {submitting ? t("auth.pleaseWait") : setupMode ? t("auth.initialize") : t("Confirm")}
            </CButton>
          </div>
        </form>
      </motion.div>
    </div>
  );
};

export default LoadingPage;

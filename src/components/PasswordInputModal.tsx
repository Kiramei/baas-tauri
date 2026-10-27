import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { Info, KeyRound, ShieldCheck } from "lucide-react";
import { FormInput } from "@/components/ui/FormInput.tsx";
import CButton from "@/components/ui/CButton.tsx";
import { loadLocale } from "@/shared/I18nTranslator.ts";
import { useSetUISettings, useUISetting } from "@/context/UISettingsProvider.tsx";
import LanguageSelect from "@/components/LanguageSelect.tsx";

const overlayCls = "fixed inset-0 flex items-center justify-center bg-black/40 p-4 z-[1100]";

/** Renders the password input modal component. */
const PasswordInputModal: React.FC<{
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
  const lowPerformanceMode = useUISetting((settings) => settings.lowPerformanceMode);
  const setUiSettings = useSetUISettings();

  useEffect(() => {
    if (!open) {
      setPassword("");
      setConfirmPassword("");
      setLocalError("");
    }
  }, [open]);

  if (!open) return null;

  /** Handles the handle confirm interaction. */
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

  /** Handles the handle language change interaction. */
  const handleLanguageChange = (value: string) => {
    void loadLocale(value).then((loaded) => {
      if (loaded) setUiSettings((state) => ({ ...state, lang: value }));
    });
  };

  return createPortal(
    <div
      data-modal-backdrop=""
      className={overlayCls}
      style={{ paddingTop: "calc(var(--window-titlebar-height, 0px) + 1rem)" }}
    >
      <motion.div
        initial={lowPerformanceMode ? false : { opacity: 0, scale: 0.96, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={lowPerformanceMode ? undefined : { opacity: 0, scale: 0.95, y: 10 }}
        transition={{ duration: lowPerformanceMode ? 0 : 0.18, ease: "easeOut" }}
        className="modal-surface w-full max-w-110 overflow-y-auto overscroll-contain"
        style={{ maxHeight: "calc(100dvh - var(--window-titlebar-height, 0px) - 2rem)" }}
      >
        <form onSubmit={(e) => e.preventDefault()}>
          <div className="modal-header items-start">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                {serverVerified ? (
                  <ShieldCheck className="size-5 shrink-0 text-muted-foreground" />
                ) : (
                  <KeyRound className="size-5 shrink-0 text-muted-foreground" />
                )}
                <h2 className="modal-title">
                  {setupMode ? t("auth.initializeKeyTitle") : t("auth.enterKeyTitle")}
                </h2>
              </div>

              <p className="mt-1 text-sm text-muted-foreground">
                {serverVerified
                  ? setupMode
                    ? t("auth.setKeySubtitle")
                    : t("auth.validateKeySubtitle")
                  : t("auth.verifyingServerIdentity")}
              </p>
            </div>

            <LanguageSelect
              handleLanguageChange={handleLanguageChange}
              className="w-auto max-w-36 shrink-0"
              hideLabel
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

          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Info className="size-4 shrink-0" />
            <span>{setupMode ? t("auth.rememberKeyTip") : t("auth.forgotKeyTip")}</span>
          </div>

          <div className="modal-footer">
            <CButton onClick={handleConfirm} disabled={!serverVerified || submitting}>
              {submitting
                ? t("auth.pleaseWait")
                : setupMode
                  ? t("auth.initialize")
                  : t("auth.confirm")}
            </CButton>
          </div>
        </form>
      </motion.div>
    </div>,
    document.body
  );
};

export default PasswordInputModal;

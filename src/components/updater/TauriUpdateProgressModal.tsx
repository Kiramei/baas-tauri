import React from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { motion } from "framer-motion";
import { Info, Loader2, X } from "lucide-react";
import { useUISetting } from "@/context/UISettingsProvider.tsx";
import CButton from "@/components/ui/CButton";

const overlayCls = "fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-[1100]";

/** Renders the tauri update progress modal component. */
export const TauriUpdateProgressModal: React.FC<{
  open: boolean;
  onClose: () => void;
  updating: boolean;
  tauriProgress: number;
  tauriStatus: string;
}> = ({ open, onClose, updating, tauriProgress, tauriStatus }) => {
  const { t } = useTranslation();
  const lowPerformanceMode = useUISetting((settings) => settings.lowPerformanceMode);
  if (!open) return null;

  return createPortal(
    <div
      data-modal-backdrop=""
      className={overlayCls}
      style={{ paddingTop: "calc(var(--window-titlebar-height, 0px) + 1rem)" }}
      onMouseDown={(event) => {
        if (!updating && event.target === event.currentTarget) onClose();
      }}
    >
      <motion.div
        initial={lowPerformanceMode ? false : { opacity: 0, scale: 0.96, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={lowPerformanceMode ? undefined : { opacity: 0, scale: 0.95, y: 10 }}
        transition={{ duration: lowPerformanceMode ? 0 : 0.18, ease: "easeOut" }}
        onMouseDown={(event) => event.stopPropagation()}
        className="modal-surface w-90 max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain"
        style={{ maxHeight: "calc(100dvh - var(--window-titlebar-height, 0px) - 2rem)" }}
      >
        <div className="modal-header">
          <div className="flex min-w-0 items-center gap-2">
            {updating ? (
              <Loader2 className="size-5 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <Info className="size-5 shrink-0 text-muted-foreground" />
            )}
            <h2 className="modal-title">{t("update.tauriInstallTitle")}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={updating}
            aria-label={t("common.close")}
            className="modal-close disabled:opacity-40"
          >
            <X className="size-4" />
          </button>
        </div>

        {tauriStatus && <p className="mb-4 text-sm text-muted-foreground">{tauriStatus}</p>}

        <div className="h-2 rounded-full bg-secondary overflow-hidden">
          <div
            className="h-full bg-[var(--control-checked)] transition-all"
            style={{ width: `${tauriProgress}%` }}
          />
        </div>

        <div className="modal-footer">
          <CButton
            onClick={onClose}
            disabled={updating}
            variant="secondary"
            className="border-transparent bg-secondary hover:bg-accent"
          >
            {t("common.cancel")}
          </CButton>
        </div>
      </motion.div>
    </div>,
    document.body
  );
};

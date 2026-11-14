import React from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { motion } from "framer-motion";
import { Info, Loader2, X } from "lucide-react";
import { useUISetting } from "@/context/UISettingsProvider.tsx";
import { useModalFocus } from "@/components/ui/Modal";
import CButton from "@/components/ui/CButton";

const overlayCls = "fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-[1100]";

/** Renders the tauri update progress modal component. */
export const TauriUpdateProgressModal: React.FC<{
  onClose: () => void;
  updating: boolean;
  progress: number | null;
  status: string;
  errorDetail: string | null;
  onRetry: () => void;
}> = ({ onClose, updating, progress, status, errorDetail, onRetry }) => {
  const { t } = useTranslation();
  const lowPerformanceMode = useUISetting((settings) => settings.lowPerformanceMode);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();
  useModalFocus(true, panelRef, () => {
    if (!updating) onClose();
  });

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
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
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
            <h2 id={titleId} className="modal-title">
              {t("update.tauriInstallTitle")}
            </h2>
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

        <p role="status" className="mb-4 text-sm text-muted-foreground">
          {status}
        </p>
        {errorDetail !== null && (
          <p role="alert" className="mb-4 break-words text-sm text-destructive">
            {errorDetail}
          </p>
        )}
        {updating && (
          <progress
            aria-label={status}
            className="h-2 w-full accent-[var(--control-checked)]"
            max={100}
            value={progress ?? undefined}
          />
        )}

        <div className="modal-footer">
          {errorDetail !== null && (
            <CButton onClick={onRetry} disabled={updating}>
              {t("androidSetup.retry")}
            </CButton>
          )}
          <CButton
            onClick={onClose}
            disabled={updating}
            variant="secondary"
            className="border-transparent bg-secondary hover:bg-accent"
          >
            {t("common.close")}
          </CButton>
        </div>
      </motion.div>
    </div>,
    document.body
  );
};

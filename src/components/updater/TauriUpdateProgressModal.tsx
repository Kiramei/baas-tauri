import React from "react";
import { useTranslation } from "react-i18next";
import { motion } from "framer-motion";
import { Info, Loader2 } from "lucide-react";
import { useUISettings } from "@/context/UISettingsProvider.tsx";

const overlayCls =
  "fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50";

/** Renders the tauri update progress modal component. */
export const TauriUpdateProgressModal: React.FC<{
  open: boolean;
  onClose: () => void;
  updating: boolean;
  tauriProgress: number;
  tauriStatus: string;
}> = ({ open, onClose, updating, tauriProgress, tauriStatus }) => {
  const { t } = useTranslation();
  const { uiSettings } = useUISettings();
  const lowPerformanceMode = uiSettings.lowPerformanceMode;
  if (!open) return null;

  return (
    <div
      className={overlayCls}
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
        className="w-90 max-w-[calc(100vw-2rem)] rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-2xl p-5"
      >
        <div className="flex items-center gap-3 mb-4">
          <div className="rounded-full bg-sky-100 dark:bg-sky-900/40 text-sky-600 p-3">
            {updating ? <Loader2 className="w-5 h-5 animate-spin" /> : <Info className="w-5 h-5" />}
          </div>
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              {t("update.tauriInstallTitle")}
            </h2>
            {tauriStatus && (
              <p className="text-sm text-slate-500 dark:text-slate-400">{tauriStatus}</p>
            )}
          </div>
        </div>

        <div className="h-2 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
          <div
            className="h-full bg-sky-600 transition-all"
            style={{ width: `${tauriProgress}%` }}
          />
        </div>

        <div className="mt-5 flex justify-end">
          <button
            onClick={onClose}
            disabled={updating}
            className="px-4 py-2 rounded-md bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-50 text-slate-700 dark:text-slate-200 transition-colors"
          >
            {t("common.cancel")}
          </button>
        </div>
      </motion.div>
    </div>
  );
};

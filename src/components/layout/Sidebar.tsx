import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  BookOpenText,
  Download,
  Home,
  Info,
  ListChecks,
  Loader2,
  PackageOpen,
  Settings,
  SlidersHorizontal,
} from "lucide-react";
import HeartbeatChart from "@/components/HeartbeatIndicator.tsx";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { useWebSocketStore, waitForNormal } from "@/store/WebsocketStore";
import { PageKey } from "@/types/app";
import { getTimestampMs } from "@/shared/GlobalUtilities.ts";

const baseUrl = import.meta.env.BASE_URL;

interface SidebarProps {
  activePage: string;
  setActivePage: (page: PageKey) => void;
}

const Sidebar: React.FC<SidebarProps> = ({ activePage, setActivePage }) => {
  const { t } = useTranslation();
  const versionConfig = useWebSocketStore((state) => state.versionStore);
  const trigger = useWebSocketStore((state) => state.trigger);
  const [backendUpdating, setBackendUpdating] = useState(false);
  const [tauriUpdating, setTauriUpdating] = useState(false);
  const [tauriProgress, setTauriProgress] = useState(0);
  const [tauriStatus, setTauriStatus] = useState("");
  const [tauriProgressOpen, setTauriProgressOpen] = useState(false);
  const tauriVersion = versionConfig["tauri"] ?? {};
  const hasBackendUpdate =
    Boolean(versionConfig["remote"]) && versionConfig["local"] !== versionConfig["remote"];
  const hasTauriUpdate = Boolean(__WITH_TAURI__ && tauriVersion.updateAvailable);
  const hasAnyUpdate = hasBackendUpdate || hasTauriUpdate;

  const navItems: Array<{ id: PageKey; label: string; icon: any }> = [
    { id: "home", label: t("nav.home"), icon: Home },
    { id: "scheduler", label: t("nav.scheduler"), icon: ListChecks },
    { id: "configuration", label: t("nav.configuration"), icon: SlidersHorizontal },
    { id: "settings", label: t("nav.settings"), icon: Settings },
    { id: "wiki", label: t("title.wiki"), icon: BookOpenText },
  ];

  const stopAllTasks = async () => {
    trigger({
      timestamp: getTimestampMs(),
      command: "stop_all_tasks",
      payload: {},
    });
    await waitForNormal(
      () => useWebSocketStore.getState().statusStore,
      (statuses) => Object.values(statuses).every((status: any) => !status?.running),
      15_000
    );
  };

  const handleBackendUpdate = async (): Promise<void> => {
    setBackendUpdating(true);
    try {
      await stopAllTasks();
      if (__WITH_TAURI__) {
        window.location.reload();
        return;
      }
      trigger({
        timestamp: getTimestampMs(),
        command: "update_to_latest",
        payload: {},
      });
      toast.info(t("update.backendStarted"));
    } catch (error) {
      toast.error(t("update.backendStartFailed"), {
        description: error instanceof Error ? error.message : String(error),
      });
      setBackendUpdating(false);
    }
  };

  const handleTauriSelfUpdate = async (): Promise<void> => {
    if (!__WITH_TAURI__) return;
    setTauriUpdating(true);
    setTauriProgressOpen(true);
    setTauriProgress(0);
    setTauriStatus(t("update.tauriChecking"));
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const { relaunch } = await import("@tauri-apps/plugin-process");
      const update = await check();
      if (!update) {
        setTauriStatus(t("update.tauriUpToDate"));
        toast.success(t("update.tauriUpToDate"));
        return;
      }
      await stopAllTasks();
      let downloaded = 0;
      let contentLength = 0;
      setTauriStatus(t("update.tauriDownloading", { version: update.version }));
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          contentLength = event.data.contentLength ?? 0;
          downloaded = 0;
          setTauriProgress(0);
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          if (contentLength > 0) {
            setTauriProgress(Math.min(100, Math.round((downloaded / contentLength) * 100)));
          }
        } else if (event.event === "Finished") {
          setTauriProgress(100);
          setTauriStatus(t("update.tauriInstalling"));
        }
      });
      await relaunch();
    } catch (error) {
      setTauriStatus(t("update.tauriFailed"));
      toast.error(t("update.tauriFailed"), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setTauriUpdating(false);
    }
  };

  return (
    <div className="relative">
      {/* 侧边栏 - 桌面端 */}
      <aside className="w-64 h-full shrink-0 bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-700 flex-col lg:block hidden">
        <div className="h-16 flex items-center border-b border-slate-200 dark:border-slate-700 px-4">
          <img src={`${baseUrl}images/logo.png`} alt="Logo" className="h-8 w-8" />
          <h1 className="text-xl font-bold text-primary-600 dark:text-primary-400 flex-1 text-start ml-2">
            {t("app.title")}
          </h1>
        </div>

        <nav className="flex-1 px-4 py-6 h-[calc(100%-64px)] flex flex-col">
          <ul>
            {navItems.map((item) => (
              <li key={item.id}>
                {item.id === "settings" && (
                  <hr
                    key={item.id + "hr"}
                    className="border border-slate-300 dark:border-slate-500"
                  />
                )}
                <button
                  onClick={() => setActivePage(item.id)}
                  className={`flex items-center w-full px-4 py-3 my-1 text-sm font-bold rounded-lg transition-colors duration-200 ${
                    activePage === item.id
                      ? "bg-primary-500 text-white"
                      : "text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                  }`}
                >
                  <item.icon className="w-5 h-5 mr-3" />
                  <span>{item.label}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="grow" />
          {hasAnyUpdate && (
            <div className="flex gap-2 mb-2">
              {hasBackendUpdate && (
                <UpdateActionButton
                  label="BAAS"
                  title={t("update.backendAction")}
                  icon={PackageOpen}
                  busy={backendUpdating}
                  onClick={handleBackendUpdate}
                  tone="red"
                />
              )}
              {hasTauriUpdate && (
                <UpdateActionButton
                  label={t("update.tauriAction")}
                  title={t("update.tauriAvailable")}
                  icon={Download}
                  busy={tauriUpdating}
                  onClick={handleTauriSelfUpdate}
                  tone="blue"
                />
              )}
            </div>
          )}
          <HeartbeatChart />
        </nav>
      </aside>

      {/* 移动端底部导航栏 */}
      <nav className="lg:hidden fixed bottom-0 left-0 w-full bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-700 flex justify-between items-center py-2 px-4 z-40">
        {navItems.map((item) => (
          <button
            key={item.id}
            onClick={() => setActivePage(item.id)}
            className={`flex flex-col items-center w-full text-sm font-medium py-2 ${
              activePage === item.id
                ? "text-primary-500"
                : "text-slate-600 dark:text-slate-300 hover:text-primary-500"
            }`}
          >
            <item.icon className="w-6 h-6 mb-1" />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      {/* 移动端悬浮更新按钮 */}
      {hasAnyUpdate && (
        <div className="lg:hidden fixed bottom-25 right-5 z-50 flex flex-col gap-3">
          {hasBackendUpdate && (
            <FloatingUpdateButton
              title={t("update.backendAction")}
              icon={PackageOpen}
              busy={backendUpdating}
              onClick={handleBackendUpdate}
              tone="red"
            />
          )}
          {hasTauriUpdate && (
            <FloatingUpdateButton
              title={t("update.tauriAvailable")}
              icon={Download}
              busy={tauriUpdating}
              onClick={handleTauriSelfUpdate}
              tone="blue"
            />
          )}
        </div>
      )}

      <TauriUpdateProgressModal
        open={tauriProgressOpen}
        onClose={() => setTauriProgressOpen(false)}
        updating={tauriUpdating}
        tauriProgress={tauriProgress}
        tauriStatus={tauriStatus}
      />
    </div>
  );
};

export default Sidebar;

const overlayCls =
  "fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50";

type UpdateTone = "red" | "blue";

const toneClasses: Record<UpdateTone, { desktop: string; floating: string }> = {
  red: {
    desktop:
      "bg-red-100/70 text-red-600 hover:bg-red-100 dark:bg-red-900/50 dark:text-red-300 dark:hover:bg-red-900/80",
    floating: "bg-red-500 hover:bg-red-600 text-white",
  },
  blue: {
    desktop:
      "bg-sky-100/80 text-sky-700 hover:bg-sky-100 dark:bg-sky-900/50 dark:text-sky-300 dark:hover:bg-sky-900/80",
    floating: "bg-sky-500 hover:bg-sky-600 text-white",
  },
};

const UpdateActionButton: React.FC<{
  label: string;
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  busy: boolean;
  onClick: () => void | Promise<void>;
  tone: UpdateTone;
}> = ({ label, title, icon: Icon, busy, onClick, tone }) => (
  <button
    type="button"
    title={title}
    aria-label={title}
    onClick={onClick}
    disabled={busy}
    className={`flex min-w-0 flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-bold transition disabled:opacity-60 ${toneClasses[tone].desktop}`}
  >
    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
    <span className="truncate">{label}</span>
  </button>
);

const FloatingUpdateButton: React.FC<{
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  busy: boolean;
  onClick: () => void | Promise<void>;
  tone: UpdateTone;
}> = ({ title, icon: Icon, busy, onClick, tone }) => (
  <motion.button
    type="button"
    title={title}
    aria-label={title}
    onClick={onClick}
    disabled={busy}
    whileHover={{ scale: 1.08 }}
    whileTap={{ scale: 0.95 }}
    animate={{ y: [0, -4, 0] }}
    transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
    className={`flex h-13 w-13 items-center justify-center rounded-full shadow-lg transition disabled:opacity-60 ${toneClasses[tone].floating}`}
  >
    {busy ? <Loader2 className="h-6 w-6 animate-spin" /> : <Icon className="h-6 w-6" />}
  </motion.button>
);

export const TauriUpdateProgressModal: React.FC<{
  open: boolean;
  onClose: () => void;
  updating: boolean;
  tauriProgress: number;
  tauriStatus: string;
}> = ({
  open,
  onClose,
  updating,
  tauriProgress,
  tauriStatus,
}) => {
  const { t } = useTranslation();
  if (!open) return null;

  return (
    <div
      className={overlayCls}
      onMouseDown={(e) => {
        if (!updating && e.target === e.currentTarget) onClose();
      }}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 10 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
        onMouseDown={(e) => e.stopPropagation()}
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

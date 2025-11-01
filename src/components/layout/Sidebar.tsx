import React, {useState} from 'react';
import {useTranslation} from 'react-i18next';
import {
  ArrowBigUpDash,
  BookOpenText,
  CheckCircle2,
  Home,
  Info,
  ListChecks,
  Settings,
  SlidersHorizontal,
  XCircle
} from 'lucide-react';
import HeartbeatChart from "@/components/HeartbeatDiv.tsx";
import {motion} from "framer-motion";
import {useWebSocketStore} from "@/store/websocketStore.ts";
import {PageKey} from "@/types/app";

interface SidebarProps {
  activePage: string;
  setActivePage: (page: PageKey) => void;
}

const Sidebar: React.FC<SidebarProps> = ({activePage, setActivePage}) => {
  const {t} = useTranslation();
  const versionConfig = useWebSocketStore(state => state.versionStore);
  const [confirmUpdate, setConfirmUpdate] = useState<boolean>(false);
  const hasUpdate = versionConfig["local"] !== versionConfig["remote"];

  const navItems: Array<{ id: PageKey, label: string, icon: any }> = [
    {id: 'home', label: t('home'), icon: Home},
    {id: 'scheduler', label: t('scheduler'), icon: ListChecks},
    {id: 'configuration', label: t('configuration'), icon: SlidersHorizontal},
    {id: 'settings', label: t('settings'), icon: Settings},
    {id: 'wiki', label: t('title.wiki'), icon: BookOpenText},
  ];

  const handleUpdate = async (): Promise<void> => {

  }

  return (
    <div className="relative">
      {/* 侧边栏 - 桌面端 */}
      <aside
        className="w-64 h-full flex-shrink-0 bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-700 flex-col lg:block hidden"
      >
        <div className="h-16 flex items-center border-b border-slate-200 dark:border-slate-700 px-4">
          <img src="/assets/images/logo.png" alt="Logo" className="h-8 w-8"/>
          <h1 className="text-xl font-bold text-primary-600 dark:text-primary-400 flex-1 text-start ml-2">
            {t("appTitle")}
          </h1>
        </div>

        <nav className="flex-1 px-4 py-6 h-[calc(100%-64px)] flex flex-col">
          <ul>
            {navItems.map((item) => (
              <li key={item.id}>
                {item.id === "settings" && (
                  <hr
                    key={item.id + "hr"}
                    className="border-[1px] border-slate-300 dark:border-slate-500"
                  />
                )}
                <button
                  onClick={() => setActivePage(item.id)}
                  className={`flex items-center w-full px-4 py-3 my-1 text-sm font-medium rounded-lg transition-colors duration-200 ${
                    activePage === item.id
                      ? "bg-primary-500 text-white"
                      : "text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                  }`}
                >
                  <item.icon className="w-5 h-5 mr-3"/>
                  <span>{item.label}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="flex-grow"/>
          {hasUpdate && (
            <button
              className="flex flex-row items-center justify-center p-4 bg-red-100/50 hover:bg-red-100/90
              dark:bg-red-900/50 hover:dark:bg-red-900/90 w-full rounded-xl self-start mb-2 transition"
              onClick={() => setConfirmUpdate(true)}
            >
              <ArrowBigUpDash className="text-red-500"/>
              <div className="ml-2 text-sm font-bold rounded-lg text-red-500">
                {t("update.available")}
              </div>
              <div className="flex-grow"/>
            </button>
          )}
          <HeartbeatChart/>

        </nav>
      </aside>

      {/* 移动端底部导航栏 */}
      <nav
        className="lg:hidden fixed bottom-0 left-0 w-full bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-700 flex justify-between items-center py-2 px-4 z-40"
      >
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
            <item.icon className="w-6 h-6 mb-1"/>
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      {/* 移动端悬浮更新按钮 */}
      {hasUpdate && (
        <motion.button
          onClick={() => setConfirmUpdate(true)}
          whileHover={{scale: 1.1}}
          whileTap={{scale: 0.95}}
          animate={{y: [0, -4, 0]}}
          transition={{duration: 2, repeat: Infinity, ease: "easeInOut"}}
          className="lg:hidden fixed bottom-25 right-5 z-50 w-14 h-14 rounded-full bg-red-500 hover:bg-red-600 text-white shadow-lg flex items-center justify-center"
        >
          <ArrowBigUpDash className="w-7 h-7"/>
        </motion.button>
      )}

      {/* 更新确认弹窗 */}
      <ConfirmUpdateModal
        open={confirmUpdate}
        localVersion={versionConfig["local"]}
        remoteVersion={versionConfig["remote"]}
        onCancel={() => setConfirmUpdate(false)}
        onConfirm={async () => {
          await handleUpdate();
          setConfirmUpdate(false);
        }}
      />
    </div>
  );
};

export default Sidebar;

const overlayCls =
  "fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50";

export const ConfirmUpdateModal: React.FC<{
  open: boolean;
  localVersion: string;
  remoteVersion: string;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}> = ({open, localVersion, remoteVersion, onCancel, onConfirm}) => {
  const {t} = useTranslation();
  if (!open) return null;

  return (
    <div
      className={overlayCls}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <motion.div
        initial={{opacity: 0, scale: 0.96, y: 10}}
        animate={{opacity: 1, scale: 1, y: 0}}
        exit={{opacity: 0, scale: 0.95, y: 10}}
        transition={{duration: 0.18, ease: "easeOut"}}
        onMouseDown={(e) => e.stopPropagation()}
        className="w-[420px] rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-2xl p-6"
      >
        {/* Header */}
        <div className="flex items-center gap-3 mb-4">
          <div className="rounded-full bg-primary-100 dark:bg-primary-900/40 text-primary-600 p-3">
            <ArrowBigUpDash className="w-6 h-6"/>
          </div>
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              {t("confirmUpdateTitle") || "Confirm Update"}
            </h2>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {t("updatePrompt") ||
                "A new version is available. Confirm to update your application."}
            </p>
          </div>
        </div>

        {/* Version Info */}
        <div
          className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40 p-3 mb-5">
          <div className="flex items-center gap-2 text-sm mb-1">
            <XCircle className="w-4 h-4 text-red-500"/>
            <span className="text-slate-600 dark:text-slate-300">
              {t("localVersion") || "Current version"}:
            </span>
            <code className="font-mono text-slate-700 dark:text-slate-100">
              {localVersion.slice(0, 8)}
            </code>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <CheckCircle2 className="w-4 h-4 text-green-500"/>
            <span className="text-slate-600 dark:text-slate-300">
              {t("remoteVersion") || "Latest version"}:
            </span>
            <code className="font-mono text-green-700 dark:text-green-300">
              {remoteVersion.slice(0, 8)}
            </code>
          </div>
        </div>

        {/* Hint */}
        <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 mb-4">
          <Info className="w-4 h-4 text-primary-500"/>
          <span>
            {t("updateNotice") ||
              "Make sure your current tasks are saved before updating."}
          </span>
        </div>

        {/* Buttons */}
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-md bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 transition-colors"
          >
            {t("cancel") || "Cancel"}
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 rounded-md bg-primary-600 hover:bg-primary-700 text-white font-medium shadow-sm transition-colors"
          >
            {t("updates") || "Update Now"}
          </button>
        </div>
      </motion.div>
    </div>
  );
};

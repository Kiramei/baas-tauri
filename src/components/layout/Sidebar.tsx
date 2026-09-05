import React, { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  BookOpenText,
  Download,
  Home,
  ListChecks,
  Loader2,
  PackageOpen,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  SlidersHorizontal,
} from "lucide-react";
import HeartbeatChart from "@/components/HeartbeatIndicator.tsx";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { useWebSocketStore, waitForNormal } from "@/store/WebsocketStore";
import { PageKey } from "@/types/app";
import { getTimestampMs } from "@/shared/GlobalUtilities.ts";
import { reloadWithoutPrompt } from "@/shared/reload";
import { useTauriSelfUpdate } from "@/context/TauriSelfUpdateProvider";
import { TauriUpdateProgressModal } from "@/components/updater/TauriUpdateProgressModal";
import { useUISetting } from "@/context/UISettingsProvider.tsx";
import { invoke } from "@/shared/TauriInvoke";
import { listen } from "@tauri-apps/api/event";

const baseUrl = import.meta.env.BASE_URL;
const InlineXTermLog = React.lazy(() => import("@/components/InlineXTermLog"));

interface SidebarProps {
  activePage: string;
  setActivePage: (page: PageKey) => void;
  desktopExpanded: boolean;
  onDesktopExpandedChange: (expanded: boolean) => void;
}

const AutoFitSidebarTitle: React.FC<{ children: string }> = ({ children }) => {
  const titleRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const title = titleRef.current;
    if (!title) return;

    const fit = () => {
      let fontSize = 15;
      title.style.fontSize = `${fontSize}px`;
      while (title.scrollWidth > title.clientWidth && fontSize > 10) {
        fontSize -= 0.25;
        title.style.fontSize = `${fontSize}px`;
      }
    };

    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(title.parentElement ?? title);
    return () => observer.disconnect();
  }, [children]);

  return (
    <div
      ref={titleRef}
      className="ml-[8px] min-w-0 flex-1 overflow-hidden whitespace-nowrap font-semibold text-slate-900 dark:text-white"
      title={children}
    >
      {children}
    </div>
  );
};

/** Renders the sidebar component. */
const Sidebar: React.FC<SidebarProps> = ({
  activePage,
  setActivePage,
  desktopExpanded,
  onDesktopExpandedChange,
}) => {
  const { t } = useTranslation();
  const versionConfig = useWebSocketStore((state) => state.versionStore);
  const trigger = useWebSocketStore((state) => state.trigger);
  const triggerStream = useWebSocketStore((state) => state.triggerStream);
  const [backendUpdating, setBackendUpdating] = useState(false);
  const [backendUpdateLogs, setBackendUpdateLogs] = useState<string[]>([]);
  const [backendUpdateTerminalText, setBackendUpdateTerminalText] = useState("");
  const [backendUpdateLogOpen, setBackendUpdateLogOpen] = useState(false);
  const tauriUpdate = useTauriSelfUpdate();
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

  /** Handles the handle backend update interaction. */
  const handleBackendUpdate = async (): Promise<void> => {
    setBackendUpdating(true);
    setBackendUpdateLogs([]);
    setBackendUpdateTerminalText("");
    setBackendUpdateLogOpen(true);
    try {
      if (__WITH_ANDROID__) {
        const stableRegions = new Map<string, any>();
        const shownStableRegions = new Set<string>();
        let sawAndroidUpdateError = false;

        const appendTerminal = (chunk: string) => {
          if (!chunk) return;
          setBackendUpdateTerminalText((prev) => prev + chunk);
        };

        const appendTerminalLine = (line: string) => {
          appendTerminal(`${line}\r\n`);
        };

        const appendStableRegion = (payload: any) => {
          const regionKey = String(payload.regionId ?? payload.taskId ?? "");
          if (regionKey && shownStableRegions.has(regionKey)) return;
          if (regionKey) shownStableRegions.add(regionKey);
          const lines = [payload.title, ...(payload.lines ?? [])]
            .map((line) => String(line ?? "").trimEnd())
            .filter(Boolean);
          if (!lines.length) return;
          appendTerminalLine(lines.join("\r\n"));
        };

        const unlisteners = await Promise.all([
          listen<any>("term:chunk", (event) => {
            appendTerminal(String(event.payload?.chunk ?? ""));
          }),
          listen<any>("term:task-started", (event) => {
            const payload = event.payload;
            appendTerminalLine(
              `[${payload.stepIndex}/${payload.stepTotal}] ${payload.name} started`
            );
          }),
          listen<any>("term:region-stable", (event) => {
            const payload = event.payload ?? {};
            stableRegions.set(String(payload.taskId ?? ""), payload);
            if (sawAndroidUpdateError) {
              appendStableRegion(payload);
            }
          }),
          listen<any>("term:task-status", (event) => {
            const payload = event.payload;
            if (payload.status === "failed" || payload.status === "stopped") {
              sawAndroidUpdateError = true;
              appendTerminalLine(
                `${payload.status.toUpperCase()} ${payload.taskId}: ${payload.error ?? ""}`
              );
              const stableRegion = stableRegions.get(String(payload.taskId ?? ""));
              if (stableRegion) {
                appendStableRegion(stableRegion);
              }
            }
          }),
          listen<any>("term:session-finished", async (event) => {
            const success = Boolean(event.payload?.success);
            appendTerminalLine(
              success ? "DONE android git2 update" : "ERROR android git2 update failed"
            );
            setBackendUpdating(false);
            for (const unlisten of unlisteners) unlisten();
            if (success) {
              toast.success(t("update.backendStarted"));
              try {
                await invoke("updater_reset_backend_auth_and_restart");
                reloadWithoutPrompt();
              } catch (error) {
                toast.error(t("update.backendStartFailed"), {
                  description: error instanceof Error ? error.message : String(error),
                });
              }
            } else {
              toast.error(t("update.backendStartFailed"));
            }
          }),
        ]);
        appendTerminalLine("START android git2 update");
        await invoke("updater_start_workflow", { request: { launch: true } });
        toast.info(t("update.backendStarted"));
        return;
      }
      await stopAllTasks();
      if (__WITH_TAURI__ && !__WITH_ANDROID__) {
        reloadWithoutPrompt();
        return;
      }
      triggerStream(
        {
          timestamp: getTimestampMs(),
          command: "update_to_latest_stream",
          payload: {},
        },
        async (event) => {
          const data = event.data ?? {};
          if (data.done) {
            if (event.status === "error") {
              setBackendUpdateLogs((prev) => [...prev, `ERROR ${String(event.error ?? "")}`]);
              toast.error(t("update.backendStartFailed"), {
                description: String(event.error ?? ""),
              });
            }
            setBackendUpdating(false);
            return;
          }
          if (data.type === "progress") {
            setBackendUpdateLogs((prev) => [...prev, formatBackendUpdateEvent(data)]);
            return;
          }
          if (data.type === "error") {
            setBackendUpdateLogs((prev) => [...prev, `ERROR ${String(data.error ?? "")}`]);
            setBackendUpdating(false);
            toast.error(t("update.backendStartFailed"), {
              description: String(data.error ?? ""),
            });
            return;
          }
          if (data.type === "result") {
            const result = data.result ?? {};
            setBackendUpdating(false);
            if (result.status === "updated") {
              setBackendUpdateLogs((prev) => [...prev, `DONE ${result.current ?? ""}`]);
              toast.success(t("update.backendStarted"), {
                description: result.current ?? result.channel ?? undefined,
              });
              if (__WITH_ANDROID__) {
                try {
                  await invoke("updater_reset_backend_auth_and_restart");
                  reloadWithoutPrompt();
                } catch (error) {
                  toast.error(t("update.backendStartFailed"), {
                    description: error instanceof Error ? error.message : String(error),
                  });
                }
              }
              return;
            }
            if (result.status === "skipped") {
              setBackendUpdateLogs((prev) => [...prev, "SKIP no_update"]);
              toast.info(t("update.tauriUpToDate"));
              return;
            }
            toast.info(t("update.backendStarted"));
          }
        }
      );
      toast.info(t("update.backendStarted"));
    } catch (error) {
      toast.error(t("update.backendStartFailed"), {
        description: error instanceof Error ? error.message : String(error),
      });
      setBackendUpdating(false);
    }
  };

  return (
    <div
      className={`relative h-full w-0 shrink-0 transition-[width] duration-300 ease-in-out ${
        desktopExpanded ? "lg:w-64" : "lg:w-[52px]"
      }`}
    >
      {/* Desktop sidebar */}
      <aside className="hidden h-full w-full flex-col overflow-hidden bg-white dark:bg-slate-900 lg:flex">
        <div className="flex h-[52px] w-full shrink-0 items-center">
          {desktopExpanded ? (
            <div className="flex w-full items-center px-[8px]">
              <AutoFitSidebarTitle>{t("app.title")}</AutoFitSidebarTitle>
              <button
                type="button"
                title="Collapse sidebar"
                aria-label="Collapse sidebar"
                aria-expanded="true"
                onClick={() => onDesktopExpandedChange(false)}
                className="flex h-[36px] w-[36px] shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <PanelLeftClose className="h-[20px] w-[20px]" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              title="Expand sidebar"
              aria-label="Expand sidebar"
              aria-expanded="false"
              onClick={() => onDesktopExpandedChange(true)}
              className="group/logo relative m-[8px] flex h-[36px] w-[36px] shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <img
                src={`${baseUrl}images/logo.png`}
                alt="BAAS"
                className="h-[20px] w-[20px] shrink-0 transition-opacity duration-150 group-hover/logo:opacity-0"
              />
              <PanelLeftOpen className="absolute h-[20px] w-[20px] opacity-0 transition-opacity duration-150 group-hover/logo:opacity-100" />
            </button>
          )}
        </div>

        <nav className="flex h-[calc(100%-52px)] flex-1 flex-col px-[8px] py-4">
          <ul>
            {navItems.map((item) => (
              <li key={item.id}>
                {item.id === "settings" && (
                  <hr key={item.id + "hr"} className="border-slate-300 dark:border-slate-500" />
                )}
                <button
                  type="button"
                  title={item.label}
                  onClick={() => setActivePage(item.id)}
                  className={`my-1 flex h-[36px] w-full items-center overflow-hidden rounded-lg px-[8px] text-sm font-bold transition-colors duration-200 ${
                    activePage === item.id
                      ? "bg-primary-500 text-white"
                      : "text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                  }`}
                >
                  <item.icon className="h-[20px] w-[20px] shrink-0" />
                  <span
                    className={`ml-3 whitespace-nowrap transition-opacity duration-150 ${
                      desktopExpanded ? "opacity-100" : "opacity-0"
                    }`}
                  >
                    {item.label}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="grow" />
          {hasAnyUpdate && (
            <div className={`mb-2 flex gap-2 ${desktopExpanded ? "flex-row" : "flex-col"}`}>
              {hasBackendUpdate && (
                <UpdateActionButton
                  label="BAAS"
                  title={t("update.backendAction")}
                  icon={PackageOpen}
                  busy={backendUpdating}
                  onClick={handleBackendUpdate}
                  tone="red"
                  expanded={desktopExpanded}
                />
              )}
              {hasTauriUpdate && (
                <UpdateActionButton
                  label={t("update.tauriAction")}
                  title={t("update.tauriAvailable")}
                  icon={Download}
                  busy={tauriUpdate.updating}
                  onClick={tauriUpdate.runUpdate}
                  tone="blue"
                  expanded={desktopExpanded}
                />
              )}
            </div>
          )}
          <HeartbeatChart expanded={desktopExpanded} />
        </nav>
      </aside>

      {/* Mobile bottom navigation */}
      <nav className="fixed bottom-0 left-0 z-40 flex w-full items-center justify-between border-t border-slate-200 bg-white px-4 py-2 dark:border-slate-700 dark:bg-slate-900 lg:hidden">
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

      {/* Mobile floating update buttons */}
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
              busy={tauriUpdate.updating}
              onClick={tauriUpdate.runUpdate}
              tone="blue"
            />
          )}
        </div>
      )}

      <TauriUpdateProgressModal
        open={tauriUpdate.progressOpen}
        onClose={() => tauriUpdate.setProgressOpen(false)}
        updating={tauriUpdate.updating}
        tauriProgress={tauriUpdate.progress}
        tauriStatus={tauriUpdate.status}
      />
      {backendUpdateLogOpen && (
        <div className="fixed inset-x-4 bottom-24 z-60 mx-auto max-w-2xl rounded-lg border border-slate-300 bg-white p-3 shadow-xl dark:border-slate-700 dark:bg-slate-950 lg:bottom-6">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Android update log
            </div>
            <button
              type="button"
              className="rounded px-2 py-1 text-sm text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
              onClick={() => setBackendUpdateLogOpen(false)}
            >
              Close
            </button>
          </div>
          {__WITH_ANDROID__ ? (
            <div className="h-64 overflow-hidden rounded bg-slate-950 p-3">
              <React.Suspense
                fallback={
                  <pre className="h-full overflow-auto text-xs leading-5 text-slate-100">
                    {backendUpdateTerminalText || "waiting...\r\n"}
                  </pre>
                }
              >
                <InlineXTermLog text={backendUpdateTerminalText || "waiting...\r\n"} />
              </React.Suspense>
            </div>
          ) : (
            <pre className="max-h-64 overflow-auto rounded bg-slate-950 p-3 text-xs leading-5 text-slate-100">
              {(backendUpdateLogs.length ? backendUpdateLogs : ["waiting..."]).join("\n")}
            </pre>
          )}
        </div>
      )}
    </div>
  );
};

export default Sidebar;

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

/** Renders the update action button component. */
const UpdateActionButton: React.FC<{
  label: string;
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  busy: boolean;
  onClick: () => void | Promise<void>;
  tone: UpdateTone;
  expanded: boolean;
}> = ({ label, title, icon: Icon, busy, onClick, tone, expanded }) => (
  <button
    type="button"
    title={title}
    aria-label={title}
    onClick={onClick}
    disabled={busy}
    className={`flex min-w-0 flex-1 items-center justify-center rounded-lg px-3 py-2 text-sm font-bold transition disabled:opacity-60 ${toneClasses[tone].desktop}`}
  >
    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
    <span
      className={`overflow-hidden whitespace-nowrap transition-[width,opacity,margin] duration-150 ${
        expanded ? "ml-2 w-auto opacity-100" : "ml-0 w-0 opacity-0"
      }`}
    >
      {label}
    </span>
  </button>
);

/** Renders the floating update button component. */
const FloatingUpdateButton: React.FC<{
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  busy: boolean;
  onClick: () => void | Promise<void>;
  tone: UpdateTone;
}> = ({ title, icon: Icon, busy, onClick, tone }) => {
  const lowPerformanceMode = useUISetting((settings) => settings.lowPerformanceMode);

  return (
    <motion.button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={busy}
      whileHover={lowPerformanceMode ? undefined : { scale: 1.08 }}
      whileTap={lowPerformanceMode ? undefined : { scale: 0.95 }}
      animate={lowPerformanceMode ? { y: 0 } : { y: [0, -4, 0] }}
      transition={{
        duration: lowPerformanceMode ? 0 : 2,
        repeat: lowPerformanceMode ? 0 : Infinity,
        ease: "easeInOut",
      }}
      className={`flex h-13 w-13 items-center justify-center rounded-full shadow-lg transition disabled:opacity-60 ${toneClasses[tone].floating}`}
    >
      {busy ? <Loader2 className="h-6 w-6 animate-spin" /> : <Icon className="h-6 w-6" />}
    </motion.button>
  );
};

const formatBytes = (value?: number): string => {
  if (!value) return "0 B";
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
};

const formatBackendUpdateEvent = (data: any): string => {
  const stage = String(data.stage ?? "progress");
  if (stage === "fetch_sha")
    return `FETCH SHA channel=${data.channel ?? ""} method=${data.method ?? ""}`;
  if (stage === "remote_sha") return `REMOTE SHA ${String(data.sha ?? "").slice(0, 12)}`;
  if (stage === "download_start") return `DOWNLOAD ${data.url ?? ""}`;
  if (stage === "download_progress") {
    if (data.total)
      return `DOWNLOADING ${formatBytes(data.downloaded)} / ${formatBytes(data.total)}`;
    return `DOWNLOADING ${formatBytes(data.downloaded)}`;
  }
  if (stage === "download_done") return `DOWNLOADED ${formatBytes(data.downloaded)}`;
  if (stage === "extract_start") return "EXTRACT archive";
  if (stage === "copy_start") return "COPY repository files";
  if (stage === "copy_done") return "COPY done";
  if (stage === "write_setup") return "WRITE setup.toml";
  if (stage === "done") return `DONE ${String(data.sha ?? "").slice(0, 12)}`;
  if (stage === "skipped") return `SKIP ${data.reason ?? ""}`;
  return stage.toUpperCase();
};

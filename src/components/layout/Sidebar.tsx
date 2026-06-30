import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  BookOpenText,
  Download,
  Home,
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
import { reloadWithoutPrompt } from "@/shared/reload";
import { useTauriSelfUpdate } from "@/context/TauriSelfUpdateProvider";
import { TauriUpdateProgressModal } from "@/components/updater/TauriUpdateProgressModal";
import { useUISettings } from "@/context/UISettingsProvider.tsx";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

const baseUrl = import.meta.env.BASE_URL;

interface SidebarProps {
  activePage: string;
  setActivePage: (page: PageKey) => void;
}

/** Renders the sidebar component. */
const Sidebar: React.FC<SidebarProps> = ({ activePage, setActivePage }) => {
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

  /** Performs the stop all tasks operation. */
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

        /** Performs the append terminal operation. */
        const appendTerminal = (chunk: string) => {
          if (!chunk) return;
          setBackendUpdateTerminalText((prev) => prev + chunk);
        };

        /** Performs the append terminal line operation. */
        const appendTerminalLine = (line: string) => {
          appendTerminal(`${line}\r\n`);
        };

        /** Performs the append stable region operation. */
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
            appendTerminalLine(`[${payload.stepIndex}/${payload.stepTotal}] ${payload.name} started`);
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
              appendTerminalLine(`${payload.status.toUpperCase()} ${payload.taskId}: ${payload.error ?? ""}`);
              const stableRegion = stableRegions.get(String(payload.taskId ?? ""));
              if (stableRegion) {
                appendStableRegion(stableRegion);
              }
            }
          }),
          listen<any>("term:session-finished", (event) => {
            const success = Boolean(event.payload?.success);
            appendTerminalLine(success ? "DONE android git2 update" : "ERROR android git2 update failed");
            setBackendUpdating(false);
            for (const unlisten of unlisteners) unlisten();
            if (success) {
              toast.success(t("update.backendStarted"));
            } else {
              toast.error(t("update.backendStartFailed"));
            }
          }),
        ]);
        appendTerminalLine("START android git2 update");
        await invoke("updater_start_workflow", { request: { launch: false } });
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
                  const { relaunch } = await import("@tauri-apps/plugin-process");
                  await relaunch();
                } catch {
                  reloadWithoutPrompt();
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
    <div className="relative">
      {/* Desktop sidebar */}
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
                  busy={tauriUpdate.updating}
                  onClick={tauriUpdate.runUpdate}
                  tone="blue"
                />
              )}
            </div>
          )}
          <HeartbeatChart />
        </nav>
      </aside>

      {/* Mobile bottom navigation */}
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
              <InlineXTermLog text={backendUpdateTerminalText || "waiting...\r\n"} />
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

/** Renders the inline xterm log component. */
const InlineXTermLog: React.FC<{ text: string }> = ({ text }) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const writtenLengthRef = useRef(0);
  const previousTextRef = useRef("");

  useEffect(() => {
    if (!hostRef.current) return;
    const term = new Terminal({
      allowProposedApi: false,
      convertEol: true,
      disableStdin: true,
      fontFamily: '"JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.18,
      scrollback: 1000,
      theme: {
        background: "#00000000",
        foreground: "#dbe7f3",
        cursor: "transparent",
        selectionBackground: "#38506b",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    termRef.current = term;
    fitRef.current = fit;

    /** Handles the resize workflow. */
    const resize = () => {
      try {
        fit.fit();
      } catch {
        // The terminal may be hidden while the update popover is closing.
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(hostRef.current);
    requestAnimationFrame(resize);

    return () => {
      observer.disconnect();
      fit.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      writtenLengthRef.current = 0;
      previousTextRef.current = "";
    };
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (text.length < writtenLengthRef.current || !text.startsWith(previousTextRef.current)) {
      term.reset();
      term.clear();
      writtenLengthRef.current = 0;
    }
    const chunk = text.slice(writtenLengthRef.current);
    if (!chunk) return;
    writtenLengthRef.current = text.length;
    previousTextRef.current = text;
    term.write(chunk);
    term.scrollToBottom();
  }, [text]);

  return <div ref={hostRef} className="terminal-host h-full w-full" />;
};

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

/** Renders the floating update button component. */
const FloatingUpdateButton: React.FC<{
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  busy: boolean;
  onClick: () => void | Promise<void>;
  tone: UpdateTone;
}> = ({ title, icon: Icon, busy, onClick, tone }) => {
  const { uiSettings } = useUISettings();
  const lowPerformanceMode = uiSettings.lowPerformanceMode;

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

/** Returns the format bytes result. */
const formatBytes = (value?: number): string => {
  if (!value) return "0 B";
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
};

/** Returns the format backend update event result. */
const formatBackendUpdateEvent = (data: any): string => {
  const stage = String(data.stage ?? "progress");
  if (stage === "fetch_sha") return `FETCH SHA channel=${data.channel ?? ""} method=${data.method ?? ""}`;
  if (stage === "remote_sha") return `REMOTE SHA ${String(data.sha ?? "").slice(0, 12)}`;
  if (stage === "download_start") return `DOWNLOAD ${data.url ?? ""}`;
  if (stage === "download_progress") {
    if (data.total) return `DOWNLOADING ${formatBytes(data.downloaded)} / ${formatBytes(data.total)}`;
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

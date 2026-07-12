import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Clipboard,
  Download,
  FileWarning,
  Loader2,
  RefreshCw,
  ScrollText,
  Search,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import CButton from "@/components/ui/CButton";
import { FormSelect } from "@/components/ui/FormSelect";
import { Modal } from "@/components/ui/Modal";
import SwitchButton from "@/components/ui/SwitchButton";
import {
  clearSystemLogs,
  collectSystemLogs,
  type SystemLogCollection,
  type SystemLogEntry,
  type SystemLogLevel,
  type SystemLogSource,
} from "@/shared/SystemLogService";

const sourceOptions: Array<"all" | SystemLogSource> = ["all", "tauri", "python", "frontend"];
const levelOptions: Array<"all" | SystemLogLevel> = [
  "all",
  "TRACE",
  "DEBUG",
  "INFO",
  "WARNING",
  "ERROR",
];

const levelClasses: Record<SystemLogLevel, string> = {
  TRACE: "text-slate-400",
  DEBUG: "text-cyan-600 dark:text-cyan-400",
  INFO: "text-blue-600 dark:text-blue-400",
  WARNING: "text-amber-600 dark:text-amber-400",
  ERROR: "text-red-600 dark:text-red-400",
};

const emptyCollection = (): SystemLogCollection => ({ entries: [], pythonFiles: [], errors: [] });

const formatTimestamp = (timestampMs: number) => {
  if (!timestampMs) return "--:--:--.---";
  const date = new Date(timestampMs);
  const pad = (value: number, width = 2) => value.toString().padStart(width, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
};

const formatDetails = (details: unknown) => {
  if (!details) return "";
  if (typeof details === "string") return details;
  try {
    return JSON.stringify(details, null, 2);
  } catch {
    return String(details);
  }
};

const formatEntries = (entries: SystemLogEntry[]) =>
  entries
    .map((entry) => {
      const line = `${formatTimestamp(entry.timestampMs)} [${entry.source}] [${entry.level}] [${
        entry.target
      }] ${entry.message}`;
      const details = formatDetails(entry.details);
      return details ? `${line}\n${details}` : line;
    })
    .join("\n");

export const SystemLogSettings: React.FC = () => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [collection, setCollection] = useState<SystemLogCollection>(emptyCollection);
  const [source, setSource] = useState<"all" | SystemLogSource>("all");
  const [level, setLevel] = useState<"all" | SystemLogLevel>("all");
  const [query, setQuery] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [followTail, setFollowTail] = useState(true);
  const [clearConfirmationOpen, setClearConfirmationOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setCollection(await collectSystemLogs());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!open || !autoRefresh) return;
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, open, refresh]);

  const filteredEntries = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return collection.entries.filter((entry) => {
      if (source !== "all" && entry.source !== source) return false;
      if (level !== "all" && entry.level !== level) return false;
      if (!normalizedQuery) return true;
      return `${entry.source} ${entry.level} ${entry.target} ${entry.message} ${formatDetails(
        entry.details
      )}`
        .toLowerCase()
        .includes(normalizedQuery);
    });
  }, [collection.entries, level, query, source]);

  useEffect(() => {
    if (!followTail || !open) return;
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [filteredEntries, followTail, open]);

  const copyLogs = async () => {
    await navigator.clipboard.writeText(formatEntries(filteredEntries));
    toast.success(t("settings.systemLogs.copied"));
  };

  const exportLogs = async () => {
    const content = formatEntries(filteredEntries);
    const filename = `baas-system-logs-${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
    if (__WITH_TAURI__) {
      try {
        const [{ save }, { writeTextFile }] = await Promise.all([
          import("@tauri-apps/plugin-dialog"),
          import("@tauri-apps/plugin-fs"),
        ]);
        const path = await save({
          defaultPath: filename,
          filters: [{ name: "Log", extensions: ["log"] }],
        });
        if (path) await writeTextFile(path, content);
        return;
      } catch {
        // Browser download remains available when a platform dialog is unavailable.
      }
    }
    const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const clearLogs = async () => {
    setClearConfirmationOpen(false);
    setLoading(true);
    try {
      await clearSystemLogs();
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      setLoading(false);
    }
  };

  const paths = [collection.tauriPath, ...collection.pythonFiles.map((file) => file.path)].filter(
    Boolean
  ) as string[];

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            <ScrollText className="size-5" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">
              {t("settings.systemLogs.title")}
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              {t("settings.systemLogs.description")}
            </div>
          </div>
        </div>
        <CButton type="button" variant="secondary" onClick={() => setOpen(true)}>
          <ScrollText className="size-4" />
          {t("settings.systemLogs.open")}
        </CButton>
      </div>

      <Modal
        isOpen={open}
        onClose={() => setOpen(false)}
        title={t("settings.systemLogs.title")}
        width={92}
      >
        <div className="flex h-[72vh] min-h-[420px] flex-col gap-3 pt-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 dark:border-slate-700 dark:bg-slate-950">
              <Search className="size-4 shrink-0 text-slate-400" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("settings.systemLogs.search")}
                className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none"
              />
            </div>
            <FormSelect
              value={source}
              onChange={(value) => setSource(value as typeof source)}
              options={sourceOptions.map((value) => ({
                value,
                label: value === "all" ? t("settings.systemLogs.allSources") : value,
              }))}
              selectId="system-log-source"
              ariaLabel={t("settings.systemLogs.source")}
              className="w-32"
            />
            <FormSelect
              value={level}
              onChange={(value) => setLevel(value as typeof level)}
              options={levelOptions.map((value) => ({
                value,
                label: value === "all" ? t("settings.systemLogs.allLevels") : value,
              }))}
              selectId="system-log-level"
              ariaLabel={t("settings.systemLogs.level")}
              className="w-28"
            />
            {[
              { icon: RefreshCw, label: t("settings.systemLogs.refresh"), action: refresh },
              { icon: Clipboard, label: t("settings.systemLogs.copy"), action: copyLogs },
              { icon: Download, label: t("settings.systemLogs.export"), action: exportLogs },
              {
                icon: Trash2,
                label: t("settings.systemLogs.clear"),
                action: () => setClearConfirmationOpen(true),
              },
            ].map(({ icon: Icon, label: buttonLabel, action }) => (
              <button
                key={buttonLabel}
                type="button"
                title={buttonLabel}
                aria-label={buttonLabel}
                onClick={() => void action()}
                disabled={loading}
                className="flex size-9 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                <Icon
                  className={`size-4 ${buttonLabel === t("settings.systemLogs.clear") ? "text-red-500" : ""}`}
                />
              </button>
            ))}
          </div>

          {clearConfirmationOpen && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">
              <span>{t("settings.systemLogs.clearConfirm")}</span>
              <div className="flex items-center gap-2">
                <CButton
                  type="button"
                  variant="secondary"
                  onClick={() => setClearConfirmationOpen(false)}
                >
                  {t("common.cancel")}
                </CButton>
                <CButton type="button" variant="danger" onClick={() => void clearLogs()}>
                  <Trash2 className="size-4" />
                  {t("settings.systemLogs.clear")}
                </CButton>
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
            <div className="flex items-center gap-3">
              <span>{t("settings.systemLogs.count", { count: filteredEntries.length })}</span>
              {loading && <Loader2 className="size-3.5 animate-spin" />}
              <SwitchButton
                checked={autoRefresh}
                onChange={setAutoRefresh}
                className="h-8 px-3 py-0 text-xs"
              >
                {t("settings.systemLogs.autoRefresh")}
              </SwitchButton>
              <SwitchButton
                checked={followTail}
                onChange={setFollowTail}
                className="h-8 px-3 py-0 text-xs"
              >
                {t("settings.systemLogs.followTail")}
              </SwitchButton>
            </div>
            {paths.length > 0 && (
              <span className="max-w-full truncate font-mono" title={paths.join("\n")}>
                {paths.join(" | ")}
              </span>
            )}
          </div>

          {collection.errors.length > 0 && (
            <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">
              <FileWarning className="mt-0.5 size-4 shrink-0" />
              <span>{collection.errors.join(" | ")}</span>
            </div>
          )}

          <div
            ref={scrollRef}
            className="min-h-0 flex-1 overflow-auto rounded-md border border-slate-700 bg-[#0b1020] font-mono text-xs text-slate-200"
          >
            {filteredEntries.length === 0 ? (
              <div className="flex h-full items-center justify-center text-slate-500">
                {t("settings.systemLogs.empty")}
              </div>
            ) : (
              <div className="min-w-max py-1">
                {filteredEntries.map((entry, index) => {
                  const details = formatDetails(entry.details);
                  return (
                    <details
                      key={`${entry.source}-${entry.timestampMs}-${index}`}
                      className="group border-b border-slate-800/80 px-2 py-1 hover:bg-slate-900/80"
                    >
                      <summary className="grid cursor-default list-none grid-cols-[190px_72px_72px_minmax(130px,220px)_minmax(360px,1fr)] gap-2 whitespace-pre-wrap">
                        <span className="text-slate-500">{formatTimestamp(entry.timestampMs)}</span>
                        <span className="text-violet-400">{entry.source}</span>
                        <span className={levelClasses[entry.level]}>{entry.level}</span>
                        <span className="truncate text-emerald-400" title={entry.target}>
                          {entry.target}
                        </span>
                        <span>{entry.message}</span>
                      </summary>
                      {details && (
                        <pre className="mt-1 max-w-[calc(100vw-120px)] whitespace-pre-wrap border-l-2 border-slate-700 pl-3 text-slate-400">
                          {details}
                        </pre>
                      )}
                    </details>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </Modal>
    </>
  );
};

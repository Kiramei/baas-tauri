import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useAppTranslation } from "@/shared/useAppTranslation";
import {
  Clipboard,
  ChevronRight,
  Download,
  FileWarning,
  Loader2,
  RefreshCw,
  ScrollText,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import CButton from "@/components/ui/CButton";
import { FormSelect } from "@/components/ui/FormSelect";
import { Modal } from "@/components/ui/Modal";
import SwitchButton from "@/components/ui/SwitchButton";
import { SearchInput } from "@/components/ui/SearchInput";
import { IconTooltip } from "@/components/ui/Tooltip";
import {
  clearSystemLogs,
  collectSystemLogs,
  type SystemLogCollection,
  type SystemLogLevel,
  type SystemLogSource,
} from "@/shared/SystemLogService";
import { getLogLevelColor } from "@/shared/LogPresentation";
import { copyBrowserText } from "@/shared/BrowserClipboard";
import { downloadBrowserFile } from "@/shared/StorageManager";
import {
  formatSystemLogDetails as formatDetails,
  formatSystemLogEntries as formatEntries,
  formatSystemLogTimestamp as formatTimestamp,
} from "@/shared/SystemLogFormatting";
import "./system-logs.css";

const sourceOptions: Array<"all" | SystemLogSource> = __WITH_TAURI__
  ? ["all", "tauri", "python", "frontend"]
  : ["all", "frontend"];
const levelOptions: Array<"all" | SystemLogLevel> = [
  "all",
  "TRACE",
  "DEBUG",
  "INFO",
  "WARNING",
  "ERROR",
];

const emptyCollection = (): SystemLogCollection => ({ entries: [], pythonFiles: [], errors: [] });

export const SystemLogSettings: React.FC = () => {
  const { t } = useAppTranslation();
  const description = __WITH_TAURI__
    ? t("settings.systemLogs.description")
    : t("settings.systemLogs.browserDescription");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [collection, setCollection] = useState<SystemLogCollection>(emptyCollection);
  const [source, setSource] = useState<"all" | SystemLogSource>("all");
  const [level, setLevel] = useState<"all" | SystemLogLevel>("all");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
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
    const normalizedQuery = deferredQuery.trim().toLowerCase();
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
  }, [collection.entries, deferredQuery, level, source]);

  useEffect(() => {
    if (!followTail || !open) return;
    const element = scrollRef.current;
    if (!element) return;
    let frame = 0;
    const follow = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        element.scrollTop = element.scrollHeight;
      });
    };
    follow();
    // Wrapped rows and content-visibility can settle after the initial render.
    // Keep following when the viewport or measured content height changes.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(follow);
    observer?.observe(element);
    if (element.firstElementChild) observer?.observe(element.firstElementChild);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [filteredEntries, followTail, open]);

  const copyLogs = async () => {
    const copied = await copyBrowserText(formatEntries(filteredEntries));
    if (copied) toast.success(t("settings.systemLogs.copied"));
    else toast.error(t("settings.systemLogs.copyFailed"));
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
    try {
      downloadBrowserFile(filename, content);
    } catch (error) {
      toast.error(t("settings.systemLogs.exportFailed"), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
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

  const sourceCounts = useMemo(() => {
    const counts: Record<"all" | SystemLogSource, number> = {
      all: collection.entries.length,
      tauri: 0,
      python: 0,
      frontend: 0,
    };
    for (const entry of collection.entries) counts[entry.source]++;
    return counts;
  }, [collection.entries]);

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent text-muted-foreground">
            <ScrollText className="size-5" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground">
              {t("settings.systemLogs.title")}
            </div>
            <div className="text-xs text-muted-foreground">{description}</div>
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
        <div className="system-logs-explorer">
          {clearConfirmationOpen && (
            <div className="system-logs-notice system-logs-notice-danger">
              <span>
                {__WITH_TAURI__
                  ? t("settings.systemLogs.clearConfirm")
                  : t("settings.systemLogs.browserClearConfirm")}
              </span>
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

          {collection.errors.length > 0 && (
            <div className="system-logs-notice system-logs-notice-warning">
              <FileWarning className="mt-0.5 size-4 shrink-0" />
              <span>{collection.errors.join(" | ")}</span>
            </div>
          )}

          <div className="system-logs-workspace">
            <aside className="system-logs-sources" aria-label={t("settings.systemLogs.source")}>
              <div className="system-logs-section-label">{t("settings.systemLogs.source")}</div>
              <div className="system-logs-source-list">
                {sourceOptions.map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={source === value}
                    className="system-logs-source"
                    onClick={() => setSource(value)}
                  >
                    <span className="system-logs-source-name">
                      {value === "all" ? t("settings.systemLogs.allSources") : value}
                    </span>
                    <span className="system-logs-source-count">{sourceCounts[value]}</span>
                  </button>
                ))}
              </div>
              <div className="system-logs-source-caption">{description}</div>
            </aside>

            <section className="system-logs-main" aria-label={t("settings.systemLogs.title")}>
              <div className="system-logs-toolbar">
                <SearchInput
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("settings.systemLogs.search")}
                  containerClassName="system-logs-search"
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
                  className="system-logs-level-filter"
                />
                <div className="system-logs-actions">
                  {[
                    {
                      icon: RefreshCw,
                      label: t("settings.systemLogs.refresh"),
                      action: refresh,
                    },
                    {
                      icon: Clipboard,
                      label: t("settings.systemLogs.copy"),
                      action: copyLogs,
                    },
                    {
                      icon: Download,
                      label: t("settings.systemLogs.export"),
                      action: exportLogs,
                    },
                    {
                      icon: Trash2,
                      label: t("settings.systemLogs.clear"),
                      action: () => setClearConfirmationOpen(true),
                    },
                  ].map(({ icon: Icon, label: buttonLabel, action }) => (
                    <IconTooltip key={buttonLabel} content={buttonLabel}>
                      <button
                        type="button"
                        aria-label={buttonLabel}
                        onClick={() => void action()}
                        disabled={loading}
                        className="system-logs-action"
                      >
                        <Icon
                          className={`size-4 ${Icon === RefreshCw && loading ? "animate-spin" : ""}`}
                        />
                      </button>
                    </IconTooltip>
                  ))}
                </div>
              </div>

              <div ref={scrollRef} className="system-logs-scroll">
                {filteredEntries.length === 0 ? (
                  <div className="system-logs-empty">
                    {loading ? (
                      <Loader2 className="size-5 animate-spin" />
                    ) : (
                      <ScrollText className="size-6" />
                    )}
                    <span>{t("settings.systemLogs.empty")}</span>
                  </div>
                ) : (
                  <div className="system-logs-entries">
                    {filteredEntries.map((entry, index) => {
                      const details = formatDetails(entry.details);
                      return (
                        <details
                          key={`${entry.source}-${entry.timestampMs}-${index}`}
                          className="system-log-entry"
                        >
                          <summary className="system-log-summary">
                            <span
                              className="system-log-marker"
                              style={{ backgroundColor: getLogLevelColor(entry.level) }}
                              aria-hidden="true"
                            />
                            <span className="sr-only">[{entry.level}] </span>
                            <time className="system-log-time">
                              {formatTimestamp(entry.timestampMs)}
                            </time>
                            <span className="system-log-source">{entry.source}</span>
                            <IconTooltip content={entry.target}>
                              <span className="system-log-target">{entry.target}</span>
                            </IconTooltip>
                            <span className="system-log-message">{entry.message}</span>
                            {details && (
                              <ChevronRight className="system-log-expand" aria-hidden="true" />
                            )}
                          </summary>
                          {details && <pre className="system-log-details">{details}</pre>}
                        </details>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="system-logs-footer">
                <span className="system-logs-result-count">
                  {t("settings.systemLogs.count", { count: filteredEntries.length })}
                </span>
                <div className="system-logs-toggles">
                  <SwitchButton
                    checked={autoRefresh}
                    onChange={setAutoRefresh}
                    label={t("settings.systemLogs.autoRefresh")}
                    className="system-logs-toggle"
                  />
                  <SwitchButton
                    checked={followTail}
                    onChange={setFollowTail}
                    label={t("settings.systemLogs.followTail")}
                    className="system-logs-toggle"
                  />
                </div>
              </div>
            </section>
          </div>
        </div>
      </Modal>
    </>
  );
};

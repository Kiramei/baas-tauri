import { resolveHttpBase } from "@/store/WebsocketStore";

export type SystemLogSource = "frontend" | "tauri" | "python";
export type SystemLogLevel = "TRACE" | "DEBUG" | "INFO" | "WARNING" | "ERROR";

export interface SystemLogEntry {
  source: SystemLogSource;
  timestampMs: number;
  level: SystemLogLevel;
  target: string;
  message: string;
  details?: unknown;
}

export interface SystemLogCollection {
  entries: SystemLogEntry[];
  tauriPath?: string;
  tauriFileSize?: number;
  pythonFiles: Array<{ path: string; size: number; modified?: string }>;
  errors: string[];
}

const MAX_FRONTEND_ENTRIES = 1500;
const MAX_PENDING_ENTRIES = 500;
const MAX_TEXT_LENGTH = 24_000;
const frontendEntries: SystemLogEntry[] = [];
let pendingEntries: SystemLogEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let installed = false;
let flushing = false;

const normalizeLevel = (level: string): SystemLogLevel => {
  switch (level.toUpperCase()) {
    case "TRACE":
      return "TRACE";
    case "DEBUG":
      return "DEBUG";
    case "WARN":
    case "WARNING":
      return "WARNING";
    case "ERROR":
    case "CRITICAL":
      return "ERROR";
    default:
      return "INFO";
  }
};

const truncate = (value: string) =>
  value.length > MAX_TEXT_LENGTH ? `${value.slice(0, MAX_TEXT_LENGTH)}...<truncated>` : value;

const serializeValue = (value: unknown): string => {
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  if (typeof value === "undefined") return "undefined";
  if (typeof value === "bigint") return `${value.toString()}n`;
  try {
    const seen = new WeakSet<object>();
    return JSON.stringify(value, (_key, nested) => {
      if (typeof nested === "bigint") return `${nested.toString()}n`;
      if (typeof nested === "object" && nested !== null) {
        if (seen.has(nested)) return "[Circular]";
        seen.add(nested);
      }
      return nested;
    });
  } catch {
    return String(value);
  }
};

const sanitizeDetails = (details: unknown): unknown => {
  if (typeof details === "undefined") return undefined;
  const serialized = serializeValue(details);
  try {
    return JSON.parse(serialized);
  } catch {
    return serialized;
  }
};

export const recordFrontendSystemLog = (
  level: SystemLogLevel,
  target: string,
  message: string,
  details?: unknown
) => {
  const entry: SystemLogEntry = {
    source: "frontend",
    timestampMs: Date.now(),
    level,
    target,
    message: truncate(message),
    details: sanitizeDetails(details),
  };
  frontendEntries.push(entry);
  if (frontendEntries.length > MAX_FRONTEND_ENTRIES) frontendEntries.shift();
  pendingEntries.push(entry);
  if (pendingEntries.length > MAX_PENDING_ENTRIES) pendingEntries.shift();
  scheduleFlush();
};

export const installFrontendSystemLogging = () => {
  if (installed || typeof window === "undefined") return;
  installed = true;

  const levels: Array<
    [keyof Pick<Console, "debug" | "info" | "log" | "warn" | "error">, SystemLogLevel]
  > = [
    ["debug", "DEBUG"],
    ["info", "INFO"],
    ["log", "INFO"],
    ["warn", "WARNING"],
    ["error", "ERROR"],
  ];
  for (const [method, level] of levels) {
    const original = console[method].bind(console);
    console[method] = ((...args: unknown[]) => {
      original(...args);
      recordFrontendSystemLog(level, `console.${method}`, args.map(serializeValue).join(" "));
    }) as Console[typeof method];
  }

  window.addEventListener("error", (event) => {
    const resizeObserverNotification = event.message.includes(
      "ResizeObserver loop completed with undelivered notifications"
    );
    recordFrontendSystemLog(
      resizeObserverNotification ? "WARNING" : "ERROR",
      resizeObserverNotification ? "resize-observer" : "window.error",
      event.error instanceof Error ? event.error.stack || event.error.message : event.message,
      {
        filename: event.filename,
        line: event.lineno,
        column: event.colno,
        href: window.location.href,
        readyState: document.readyState,
        activeElement: document.activeElement?.tagName,
      }
    );
  });
  window.addEventListener("unhandledrejection", (event) => {
    recordFrontendSystemLog("ERROR", "unhandledrejection", serializeValue(event.reason));
  });
  window.addEventListener("online", () =>
    recordFrontendSystemLog("INFO", "network", "Browser network state changed to online")
  );
  window.addEventListener("offline", () =>
    recordFrontendSystemLog("WARNING", "network", "Browser network state changed to offline")
  );

  recordFrontendSystemLog("INFO", "lifecycle", "Frontend system logging initialized", {
    href: window.location.href,
    userAgent: navigator.userAgent,
    language: navigator.language,
    platform: navigator.platform,
    tauri: __WITH_TAURI__,
    android: __WITH_ANDROID__,
  });
};

export const collectSystemLogs = async (limit = 4000): Promise<SystemLogCollection> => {
  await flushFrontendLogs();
  const collection: SystemLogCollection = {
    entries: [...frontendEntries],
    pythonFiles: [],
    errors: [],
  };

  const tasks: Promise<void>[] = [];
  if (__WITH_TAURI__) {
    tasks.push(
      (async () => {
        try {
          const { invoke } = await import("@/shared/TauriInvoke");
          const snapshot = await invoke<any>("system_logs_snapshot", { request: { limit } });
          collection.tauriPath = String(snapshot?.path ?? "");
          collection.tauriFileSize = Number(snapshot?.fileSize ?? 0);
          collection.entries.push(...((snapshot?.entries ?? []) as SystemLogEntry[]));
        } catch (error) {
          collection.errors.push(`Tauri: ${serializeValue(error)}`);
        }
      })()
    );
  }

  tasks.push(
    (async () => {
      try {
        const response = await fetch(`${resolveHttpBase()}/system/logs?limit=${limit}`, {
          credentials: "include",
          cache: "no-store",
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        collection.pythonFiles = Array.isArray(payload?.files) ? payload.files : [];
        for (const entry of payload?.entries ?? []) {
          collection.entries.push({
            source: "python",
            timestampMs: Date.parse(entry.timestamp || "") || 0,
            level: normalizeLevel(entry.level || "INFO"),
            target: entry.logger || entry.module || "python",
            message: entry.message || "",
            details: {
              exception: entry.exception,
              stack: entry.stack,
              module: entry.module,
              line: entry.line,
              process: entry.process,
              thread: entry.thread,
            },
          });
        }
      } catch (error) {
        collection.errors.push(`Python: ${serializeValue(error)}`);
      }
    })()
  );

  await Promise.all(tasks);
  const unique = new Map<string, SystemLogEntry>();
  for (const entry of collection.entries) {
    const key = `${entry.source}|${entry.timestampMs}|${entry.level}|${entry.target}|${entry.message}`;
    unique.set(key, entry);
  }
  collection.entries = Array.from(unique.values())
    .sort((a, b) => a.timestampMs - b.timestampMs)
    .slice(-limit);
  return collection;
};

export const clearSystemLogs = async () => {
  frontendEntries.length = 0;
  pendingEntries = [];
  const tasks: Promise<unknown>[] = [];
  if (__WITH_TAURI__) {
    tasks.push(import("@/shared/TauriInvoke").then(({ invoke }) => invoke("system_logs_clear")));
  }
  tasks.push(
    fetch(`${resolveHttpBase()}/system/logs/clear`, {
      method: "POST",
      credentials: "include",
    }).then((response) => {
      if (!response.ok) throw new Error(`Python log clear failed: HTTP ${response.status}`);
    })
  );
  const results = await Promise.allSettled(tasks);
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    throw new Error(
      failures
        .map((result) => (result.status === "rejected" ? serializeValue(result.reason) : ""))
        .join(" | ")
    );
  }
  recordFrontendSystemLog("INFO", "system_logs", "System logs cleared from settings");
};

const scheduleFlush = () => {
  if (!__WITH_TAURI__ || flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushFrontendLogs();
  }, 1000);
};

const flushFrontendLogs = async () => {
  if (!__WITH_TAURI__ || flushing || pendingEntries.length === 0) return;
  flushing = true;
  const batch = pendingEntries.splice(0, 250);
  try {
    const { invoke } = await import("@/shared/TauriInvoke");
    await invoke("system_logs_ingest_frontend", { request: { entries: batch } });
  } catch {
    pendingEntries = [...batch, ...pendingEntries].slice(-MAX_PENDING_ENTRIES);
  } finally {
    flushing = false;
    if (pendingEntries.length > 0) scheduleFlush();
  }
};

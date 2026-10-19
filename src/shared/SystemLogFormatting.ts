import type { SystemLogEntry } from "./SystemLogService";

export const formatSystemLogTimestamp = (timestampMs: number) => {
  if (!timestampMs) return "--:--:--.---";
  const date = new Date(timestampMs);
  const pad = (value: number, width = 2) => value.toString().padStart(width, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
};

export const formatSystemLogDetails = (details: unknown): string => {
  if (details === undefined || details === null || details === "") return "";
  if (typeof details === "string") return details;
  try {
    return JSON.stringify(details, null, 2);
  } catch {
    return String(details);
  }
};

// Export and clipboard output retain the original level; colored markers are UI only.
export const formatSystemLogEntries = (entries: SystemLogEntry[]) =>
  entries
    .map((entry) => {
      const line = `${formatSystemLogTimestamp(entry.timestampMs)} [${entry.source}] [${entry.level}] [${
        entry.target
      }] ${entry.message}`;
      const details = formatSystemLogDetails(entry.details);
      return details ? `${line}\n${details}` : line;
    })
    .join("\n");

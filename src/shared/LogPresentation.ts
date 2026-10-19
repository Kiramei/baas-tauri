// Presentation only: never normalize or remove the level stored in a log record.
export const normalizeLogLevel = (level: string): string => {
  const normalized = level.trim().toUpperCase();
  if (normalized === "WARN") return "WARNING";
  if (normalized === "FATAL") return "CRITICAL";
  return normalized;
};

const levelColors: Record<string, string> = {
  TRACE: "#94a3b8",
  DEBUG: "#5794ee",
  INFO: "#5794ee",
  WARNING: "#dc9a40",
  ERROR: "#e56369",
  CRITICAL: "#aa80dc",
};

export const getLogLevelColor = (level: string): string =>
  levelColors[normalizeLogLevel(level)] ?? "#89939e";

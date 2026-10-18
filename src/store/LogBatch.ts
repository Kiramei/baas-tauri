import type { LogItem, RawLogItem } from "@/types/app";

/** Group once so replaying a history snapshot does not copy the store for every row. */
export function groupLogEntries(entries: readonly RawLogItem[]): Record<string, LogItem[]> {
  const groups = new Map<string, LogItem[]>();
  for (const entry of entries) {
    const logs = groups.get(entry.scope) ?? [];
    if (!groups.has(entry.scope)) groups.set(entry.scope, logs);
    logs.push({ time: entry.time, level: entry.level, message: entry.message });
  }
  return Object.fromEntries(groups);
}

export function appendLogGroups(
  current: Record<string, LogItem[]>,
  groups: Record<string, LogItem[]>
): Record<string, LogItem[]> {
  const next = { ...current };
  for (const [scope, logs] of Object.entries(groups)) {
    next[scope] = [...(current[scope] ?? []), ...logs];
  }
  return next;
}

/** Keep every row in order, but publish bursts at most once per display interval. */
export function createLogBatch(
  publish: (entries: RawLogItem[]) => void,
  options: {
    delayMs?: number;
    maxEntries?: number;
    schedule?: (callback: () => void, delayMs: number) => unknown;
    cancel?: (handle: unknown) => void;
  } = {}
) {
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const maxEntries = Math.max(1, options.maxEntries ?? 256);
  let entries: RawLogItem[] = [];
  let timer: unknown = null;

  const clearTimer = () => {
    if (timer !== null) cancel(timer);
    timer = null;
  };
  const flush = () => {
    clearTimer();
    if (entries.length === 0) return;
    const batch = entries;
    entries = [];
    publish(batch);
  };
  return {
    push(entry: RawLogItem) {
      entries.push(entry);
      if (entries.length >= maxEntries) flush();
      else if (timer === null) timer = schedule(flush, options.delayMs ?? 16);
    },
    flush,
    clear() {
      clearTimer();
      entries = [];
    },
  };
}

import type { EventConfig } from "@/types/event";

/** Enabled tasks stay first; equal sort values retain their existing order. */
export function sortSchedulerTasks(
  tasks: readonly EventConfig[],
  mode: "default" | "time"
): EventConfig[] {
  const field = mode === "time" ? "next_tick" : "priority";
  return [...tasks].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a[field] - b[field]);
}

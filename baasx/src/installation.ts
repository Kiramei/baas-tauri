import type { RuntimeEvent } from "./runtime";

export interface InstallationTask {
  id: string;
  stage: string;
  message: string;
  status: "pending" | "running" | "complete" | "failed" | "skipped";
  percent?: number;
  current?: number;
  total?: number;
  unit?: "bytes" | "objects" | "items";
  downloadedBytes?: number;
  totalBytes?: number;
  currentLine?: string;
  startedAt?: number;
  finishedAt?: number;
  /** Latest committed output; repaint frames only update currentLine. */
  lines: string[];
}

export interface InstallationProgress {
  stage: string;
  message: string;
  tasks: InstallationTask[];
  /** Completed log lines only. Repainting output belongs to task.currentLine. */
  lines: string[];
  startedAt?: number;
}

const MAX_TASKS = 64;
const MAX_LINES = 80;
const TASK_LINES = 6;

function appendLines(previous: string[], message: string, maximum: number): string[] {
  const next = [...previous];
  for (const line of message.split("\n").filter(Boolean)) {
    if (next.at(-1) !== line) next.push(line.slice(0, 4096));
  }
  return next.slice(-maximum);
}

/** Immutable bounded state for the TUI; CR frames never append to the log. */
export function reduceInstallationProgress(
  previous: InstallationProgress | undefined,
  event: RuntimeEvent,
  now = Date.now()
): InstallationProgress {
  const id = event.taskId || event.stage;
  const tasks = [...(previous?.tasks || [])];
  const index = tasks.findIndex((task) => task.id === id);
  const before = index < 0 || event.status === "pending" ? undefined : tasks[index];
  const task: InstallationTask = {
    ...before,
    id,
    stage: event.stage,
    message: event.message,
    status:
      event.status || (before?.status === "pending" ? "running" : before?.status) || "running",
    lines: [...(before?.lines || [])],
  };
  if (event.status === "running" && before && !["pending", "running"].includes(before.status)) {
    for (const key of [
      "percent",
      "current",
      "total",
      "unit",
      "downloadedBytes",
      "totalBytes",
      "currentLine",
    ] as const)
      delete task[key];
  }
  for (const key of [
    "percent",
    "current",
    "total",
    "unit",
    "downloadedBytes",
    "totalBytes",
    "currentLine",
  ] as const) {
    if (event[key] !== undefined) Object.assign(task, { [key]: event[key] });
  }
  if (event.replace === true && event.currentLine === undefined) task.currentLine = event.message;
  if (task.status === "running") {
    task.startedAt ??= now;
    delete task.finishedAt;
  } else if (task.status !== "pending") {
    if (task.status !== "skipped") task.startedAt ??= now;
    if (before?.status !== task.status || task.finishedAt === undefined) task.finishedAt = now;
    if (event.status === "failed" && event.currentLine === undefined)
      task.currentLine = event.message;
  }
  if (event.replace !== true && task.status !== "pending")
    task.lines = appendLines(task.lines, event.message, TASK_LINES);
  if (task.status === "complete") task.percent = 100;
  if (index < 0) tasks.push(task);
  else tasks[index] = task;
  // Preparing the private config finishes once a real workflow task starts;
  // it must not look active throughout all downloads or survive a failed step.
  if (id !== "prepare" && task.status !== "pending") {
    const preparation = tasks.findIndex(
      (task) => task.id === "prepare" && task.status === "running"
    );
    if (preparation >= 0)
      tasks[preparation] = {
        ...tasks[preparation],
        status: "complete",
        percent: 100,
        finishedAt: now,
      };
  }
  const complete = event.stage === "complete" && event.status === "complete";
  const failed =
    ["failed", "error", "cancelled"].includes(event.stage) && event.status === "failed";
  if (complete || failed) {
    for (let index = 0; index < tasks.length; index++) {
      const task = tasks[index];
      if (task.status === "running")
        tasks[index] = {
          ...task,
          status: complete ? "complete" : "failed",
          finishedAt: now,
          ...(complete ? { percent: 100 } : {}),
        };
      else if (task.status === "pending")
        tasks[index] = { ...task, status: "skipped", finishedAt: now };
    }
  }
  const lines =
    event.replace !== true && task.status !== "pending"
      ? appendLines(previous?.lines || [], event.message, MAX_LINES)
      : [...(previous?.lines || [])];
  return {
    stage: event.stage,
    message: event.message,
    tasks: tasks.slice(-MAX_TASKS),
    lines,
    startedAt: previous?.startedAt ?? (task.status === "pending" ? undefined : now),
  };
}

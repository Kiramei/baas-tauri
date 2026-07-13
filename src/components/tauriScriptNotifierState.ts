export type ScriptStatus = {
  running?: boolean;
  config_id?: string | null;
  current_task?: string | null;
  waiting_tasks?: string[];
  exit_code?: number | string | null;
  run_mode?: "scheduler" | "single" | null;
};

export type StatusSnapshot = {
  running: boolean;
  currentTask: string | null;
  lastTask: string | null;
  exitCode: number | string | null;
  runMode: "scheduler" | "single" | null;
};

/** Converts a possibly incomplete store entry into a stable notification snapshot. */
export const createStatusSnapshot = (
  status: ScriptStatus | null | undefined,
  previous?: StatusSnapshot
): StatusSnapshot | null => {
  if (!status) return null;
  const currentTask = status.current_task ?? null;
  return {
    running: Boolean(status.running),
    currentTask,
    lastTask: currentTask ?? previous?.lastTask ?? null,
    exitCode: status.exit_code ?? null,
    runMode: status.run_mode ?? null,
  };
};

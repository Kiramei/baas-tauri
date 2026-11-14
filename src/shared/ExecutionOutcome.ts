export type ExecutionOutcome = "running" | "failed" | "idle";

export interface ExecutionStatus {
  running?: boolean;
  exit_code?: number | string | null;
  /** Local intent for this run; cleared by its next observed start. */
  _stopRequested?: boolean;
  _stopRequestToken?: number | null;
}

export function isFailureExitCode(exitCode: ExecutionStatus["exit_code"]): boolean {
  if (exitCode == null || String(exitCode).trim() === "") return false;
  const numeric = Number(exitCode);
  return Number.isFinite(numeric) ? numeric !== 0 : true;
}

/** Runtime outcomes come from execution status, never a historical ERROR log. */
export function getExecutionOutcome(status?: ExecutionStatus | null): ExecutionOutcome {
  if (status?.running) return "running";
  if (!status?._stopRequested && isFailureExitCode(status?.exit_code)) return "failed";
  return "idle";
}

/** A new run must not inherit a previous run's error or an earlier stop request. */
export function mergeExecutionStatus<T extends ExecutionStatus & { run_id?: string | null }>(
  previous: T | undefined,
  incoming: Partial<T>
): T {
  const starting = incoming.running === true &&
    (!previous?.running || (!!incoming.run_id && incoming.run_id !== previous.run_id));
  return {
    ...previous,
    ...incoming,
    ...(starting ? { exit_code: null, _stopRequested: false, _stopRequestToken: null } : {}),
  } as T;
}

import { getExecutionOutcome, isFailureExitCode } from "@/shared/ExecutionOutcome";
import type { ScriptStatusDelivery } from "@/shared/ScriptStatusEvents";

export type ScriptStatus = {
  running?: boolean;
  config_id?: string | null;
  current_task?: string | null;
  waiting_tasks?: string[];
  exit_code?: number | string | null;
  run_mode?: "scheduler" | "single" | null;
  run_id?: string | null;
  timestamp?: number;
  _stopRequested?: boolean;
};

export type StatusSnapshot = {
  running: boolean;
  currentTask: string | null;
  lastTask: string | null;
  exitCode: number | string | null;
  runMode: "scheduler" | "single" | null;
  runId: string | null;
  stopRequested: boolean;
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
    runId: status.run_id ?? null,
    stopRequested: status._stopRequested === true,
  };
};

export interface ScriptLifecycleEvent {
  kind: "started" | "completed" | "failed";
  configId: string;
  task: string | null;
  scheduler: boolean;
  exitCode: number | string | null;
  key: string;
  tag: string;
}

/** Consumes actual provider deliveries; store hydration is never an execution event. */
export class ScriptNotificationTracker {
  private source = -1;
  private previous = new Map<string, StatusSnapshot>();
  private identities = new Map<string, string>();
  private sequence = 0;
  private delivered = new Set<string>();
  private baselineReady = false;

  accept(delivery: ScriptStatusDelivery): ScriptLifecycleEvent[] {
    if (delivery.source !== this.source || delivery.kind === "reset") {
      this.source = delivery.source;
      this.previous.clear();
      this.identities.clear();
      this.baselineReady = false;
    }
    if (delivery.kind === "reset") return [];
    if (delivery.kind === "snapshot") {
      this.previous.clear();
      this.identities.clear();
      this.baselineReady = true;
    }
    const events: ScriptLifecycleEvent[] = [];
    for (const [configId, status] of Object.entries(delivery.statuses)) {
      const previous = this.previous.get(configId);
      const next = createStatusSnapshot(status, previous);
      if (!next) continue;
      const started =
        next.running && (!previous?.running || (!!next.runId && next.runId !== previous.runId));
      if (
        started ||
        (next.runId && next.runId !== previous?.runId) ||
        !this.identities.has(configId)
      ) {
        this.identities.set(configId, next.runId ?? `local-${++this.sequence}`);
      }
      this.previous.set(configId, next);
      if ((delivery.kind !== "update" && delivery.kind !== "rejected-stop") || !this.baselineReady)
        continue;

      const scheduler = next.runMode === "scheduler";
      const task = next.currentTask ?? previous?.currentTask ?? previous?.lastTask ?? null;
      const emit = (kind: ScriptLifecycleEvent["kind"]) => {
        const key = `${this.source}:${configId}:${this.identities.get(configId)}:${kind}`;
        if (this.delivered.has(key)) return;
        this.delivered.add(key);
        // Keep only recent execution identities; no persistence/replay queue.
        if (this.delivered.size > 512) this.delivered.delete(this.delivered.values().next().value!);
        events.push({
          kind,
          configId,
          task,
          scheduler,
          exitCode: next.exitCode,
          key,
          tag: `script:${configId}:${kind}`,
        });
      };
      if (started) emit("started");
      if (next.stopRequested || started) continue;
      const stopped = !next.running;
      const previouslyFailed =
        previous &&
        getExecutionOutcome({
          running: previous.running,
          exit_code: previous.exitCode,
          _stopRequested: previous.stopRequested,
        }) === "failed";
      if (
        stopped &&
        getExecutionOutcome(status) === "failed" &&
        (!previouslyFailed || next.runId !== previous?.runId)
      ) {
        emit("failed");
      } else if (
        !isFailureExitCode(next.exitCode) &&
        previous?.running &&
        ((scheduler &&
          previous.currentTask &&
          !next.currentTask &&
          (status.waiting_tasks?.length ?? 0) === 0) ||
          (!scheduler && stopped && task))
      ) {
        emit("completed");
      }
    }
    return events;
  }
}

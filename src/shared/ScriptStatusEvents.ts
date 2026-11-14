import type { ScriptStatus } from "@/components/tauriScriptNotifierState";

export interface ScriptStatusDelivery {
  source: number;
  kind: "reset" | "snapshot" | "update" | "rejected-stop";
  statuses: Record<string, ScriptStatus>;
}

const listeners = new Set<(event: ScriptStatusDelivery) => void>();
let source = 0;
let statuses: Record<string, ScriptStatus> = {};

/** Each provider connection owns a separate baseline, including reconnects without new auth. */
export function beginScriptStatusSource(): number {
  source++;
  statuses = {};
  for (const listener of listeners) listener({ source, kind: "reset", statuses });
  return source;
}

export function publishScriptStatus(incoming: ScriptStatusDelivery): void {
  if (incoming.source !== source) return;
  statuses =
    incoming.kind === "update" || incoming.kind === "rejected-stop"
      ? { ...statuses, ...incoming.statuses }
      : incoming.statuses;
  for (const listener of listeners) listener(incoming);
}

export function subscribeScriptStatus(listener: (event: ScriptStatusDelivery) => void): () => void {
  listeners.add(listener);
  listener({ source, kind: "snapshot", statuses });
  return () => {
    listeners.delete(listener);
  };
}

/** A refused stop cannot hide a real terminal failure that arrived before its ACK. */
export function publishRejectedStopOutcome(configId: string, corrected: ScriptStatus): void {
  const observed = statuses[configId];
  if (
    !observed ||
    corrected.running ||
    corrected.run_id !== observed.run_id ||
    corrected.running !== observed.running ||
    corrected.exit_code !== observed.exit_code ||
    statusTimestamp(corrected) !== statusTimestamp(observed)
  )
    return;
  publishScriptStatus({ source, kind: "rejected-stop", statuses: { [configId]: corrected } });
}

/** The provider sends epoch milliseconds; never infer units or compare remote clocks to local time. */
export function statusTimestamp(status: ScriptStatus | undefined): number | null {
  return typeof status?.timestamp === "number" && Number.isFinite(status.timestamp)
    ? status.timestamp
    : null;
}

export function isReplayedStatus(
  incoming: ScriptStatus,
  previous: ScriptStatus | undefined,
  snapshotWatermark: number | undefined
): boolean {
  const timestamp = statusTimestamp(incoming);
  if (timestamp === null) return false;
  // subscribe_status precedes current_status on the server. Already queued
  // updates can follow a newer initial snapshot on the same connection.
  if (snapshotWatermark !== undefined && timestamp <= snapshotWatermark) return true;
  const previousTimestamp = statusTimestamp(previous);
  return previousTimestamp !== null && timestamp < previousTimestamp;
}

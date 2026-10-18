import type { BackendTransportMode } from "@/transport/types";

/** A new authenticated connection gets a full grace period before recovery. */
export class HeartbeatWatchdog {
  private mode?: BackendTransportMode;
  private phase?: string;
  private heartbeat?: number;

  constructor(private lastSeenAt: number) {}

  update(mode: BackendTransportMode, phase: string, heartbeat: number, now: number): void {
    if (mode !== this.mode || phase !== this.phase || heartbeat !== this.heartbeat) {
      this.lastSeenAt = now;
    }
    this.mode = mode;
    this.phase = phase;
    this.heartbeat = heartbeat;
  }

  shouldRecover(now: number): boolean {
    return (
      this.mode === "websocket" && this.phase === "authenticated" && now - this.lastSeenAt > 5000
    );
  }
}

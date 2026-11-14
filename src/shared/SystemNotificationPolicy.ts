export interface SystemNotificationPayload {
  title: string;
  body: string;
  tag: string;
}

export interface SystemNotificationRequest {
  key: string;
  group: string;
  payload: SystemNotificationPayload;
  runKey?: string;
  terminal?: boolean;
  failure?: boolean;
  cooldownMs?: number;
}

interface PendingNotification extends SystemNotificationRequest {
  expiresAt: number;
}
interface NotificationDependencies {
  enabled: () => boolean;
  isBackground: () => Promise<boolean>;
  send: (payload: SystemNotificationPayload) => Promise<unknown>;
  summarize: (latest: string, count: number) => string;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

/** Only fresh background events enter this short-lived, bounded batch. */
export class SystemNotificationDispatcher {
  private pending = new Map<string, Map<string, PendingNotification>>();
  private seen = new Map<string, number>();
  private terminalRuns = new Map<string, boolean>();
  private sentAt = new Map<string, number>();
  private timer: unknown = null;
  private flushing = false;
  private generation = 0;
  private now: () => number;

  constructor(private dependencies: NotificationDependencies) {
    this.now = dependencies.now ?? Date.now;
  }

  clear(): void {
    this.generation++;
    this.pending.clear();
    if (this.timer !== null) {
      (
        this.dependencies.clearTimer ??
        ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
      )(this.timer);
      this.timer = null;
    }
  }

  async enqueue(request: SystemNotificationRequest): Promise<void> {
    const createdAt = this.now();
    if ((this.seen.get(request.key) ?? -Infinity) > createdAt - (request.cooldownMs ?? 60_000))
      return;
    // Foreground/disabled events are consumed too, never saved for a later hide.
    this.seen.set(request.key, createdAt);
    if (this.seen.size > 512) this.seen.delete(this.seen.keys().next().value!);
    if (request.runKey && this.terminalRuns.get(request.runKey) && !request.failure) return;
    if (request.terminal && request.runKey) {
      this.terminalRuns.set(request.runKey, request.failure === true);
      if (this.terminalRuns.size > 512)
        this.terminalRuns.delete(this.terminalRuns.keys().next().value!);
      for (const group of this.pending.values()) {
        for (const [key, pending] of group) {
          if (
            pending.runKey === request.runKey &&
            (!pending.terminal || (request.failure && !pending.failure))
          )
            group.delete(key);
        }
      }
    }
    if (!request.terminal && request.runKey && this.terminalRuns.has(request.runKey)) return;
    const generation = this.generation;
    if (!this.dependencies.enabled() || !(await this.dependencies.isBackground())) return;
    if (generation !== this.generation || !this.dependencies.enabled()) return;
    if (request.runKey && this.terminalRuns.get(request.runKey) && !request.failure) return;
    if (!request.terminal && request.runKey && this.terminalRuns.has(request.runKey)) return;
    const now = this.now();
    if (now - createdAt > 10_000) return;
    const group = this.pending.get(request.group) ?? new Map<string, PendingNotification>();
    group.set(request.key, { ...request, expiresAt: createdAt + 10_000 });
    if (group.size > 128) group.delete(group.keys().next().value!);
    this.pending.set(request.group, group);
    this.schedule(300);
  }

  private schedule(delay: number): void {
    if (this.timer !== null || this.flushing || this.pending.size === 0) return;
    this.timer = (this.dependencies.setTimer ?? setTimeout)(() => {
      this.timer = null;
      void this.flush().catch((error) =>
        console.warn("[notifier] notification delivery failed", error)
      );
    }, delay);
  }

  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    const generation = this.generation;
    let nextDelay = Infinity;
    try {
      if (!this.dependencies.enabled() || !(await this.dependencies.isBackground())) {
        this.clear();
        return;
      }
      if (generation !== this.generation) return;
      const groups = [...this.pending].sort(
        ([left], [right]) => Number(right.includes("failed")) - Number(left.includes("failed"))
      );
      for (const [name, group] of groups) {
        const now = this.now();
        const entries = [...group.values()].filter((entry) => entry.expiresAt >= now);
        if (!entries.length) {
          this.pending.delete(name);
          continue;
        }
        const latest = entries[entries.length - 1];
        const remaining = (this.sentAt.get(name) ?? -Infinity) + (latest.cooldownMs ?? 3_000) - now;
        if (remaining > 0) {
          nextDelay = Math.min(nextDelay, remaining);
          continue;
        }
        this.pending.delete(name);
        if (generation !== this.generation || !this.dependencies.enabled()) return;
        // Recheck after a previous send yielded; a user may have returned to BAAS.
        if (!(await this.dependencies.isBackground())) {
          this.clear();
          return;
        }
        if (generation !== this.generation || !this.dependencies.enabled()) return;
        const fresh = entries.filter(
          (entry) =>
            entry.expiresAt >= this.now() &&
            !(entry.runKey && this.terminalRuns.get(entry.runKey) && !entry.failure)
        );
        if (!fresh.length) continue;
        const current = fresh[fresh.length - 1];
        this.sentAt.set(name, this.now());
        await this.dependencies.send(
          fresh.length === 1
            ? current.payload
            : {
                ...current.payload,
                body: this.dependencies.summarize(current.payload.body, fresh.length),
                tag: name.startsWith("script:")
                  ? `script:batch:${name.slice("script:".length)}`
                  : current.payload.tag,
              }
        );
      }
    } finally {
      this.flushing = false;
      if (this.pending.size)
        this.schedule(Math.max(1, Number.isFinite(nextDelay) ? nextDelay : 300));
    }
  }
}

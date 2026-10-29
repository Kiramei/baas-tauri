import type { BaasLogEntry } from "@baas/client";

export interface RunStatus {
  running?: boolean;
  run_id?: string | null;
  exit_code?: number | null;
  current_task?: string | null;
  [key: string]: unknown;
}
export type StatusSnapshot = Record<string, RunStatus>;
export interface MonitoringClient {
  connect(): Promise<void>;
  status(): Promise<StatusSnapshot>;
  logs(limit?: number, profile?: string): Promise<BaasLogEntry[]>;
  onLog(listener: (entry: BaasLogEntry) => void): () => void;
  onStatus(listener: (update: any, snapshot: StatusSnapshot) => void): () => void;
  onDisconnect(listener: (error: Error) => void): () => void;
  readonly statusSnapshot: StatusSnapshot;
}
export type MonitorEvent =
  | { type: "live-log"; entry: BaasLogEntry }
  | { type: "run-status"; profile: string; status: RunStatus }
  | { type: "connection"; state: "lost" | "retrying" | "restored"; message: string };
export interface RunResult {
  accepted: boolean;
  completed: boolean;
  profile: string;
  run_id: string | null;
  succeeded: boolean | null;
  status: RunStatus;
  submission?: unknown;
}
export class MonitorError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "MonitorError";
  }
}

function deadline(signal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(
        new MonitorError("wait_timeout", "等待超时；已提交的后端任务仍可能在运行，请用 status 查看")
      ),
    timeoutMs
  );
  return {
    signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    dispose: () => clearTimeout(timer),
  };
}
export async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    void promise.catch(() => {});
    signal.throwIfAborted();
  }
  if (!signal) return promise;
  let listener: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    listener = () => reject(signal.reason ?? new DOMException("操作已取消", "AbortError"));
    signal.addEventListener("abort", listener, { once: true });
    if (signal.aborted) listener();
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", listener);
  }
}
async function pause(ms: number, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await abortable(
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
      signal
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Reconnection only reopens subscriptions/reads. Submitted operations are never replayed. */
async function reconnect(
  client: MonitoringClient,
  signal: AbortSignal,
  onEvent?: (event: MonitorEvent) => void,
  catchUp?: () => Promise<void>
) {
  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    signal.throwIfAborted();
    onEvent?.({
      type: "connection",
      state: "retrying",
      message: `正在恢复只读连接（${attempt}/3），不会重复提交任务`,
    });
    if (attempt > 1) await pause(250 * 2 ** (attempt - 2), signal);
    try {
      await abortable(client.connect(), signal);
      const snapshot = await abortable(client.status(), signal);
      await catchUp?.();
      signal.throwIfAborted();
      onEvent?.({ type: "connection", state: "restored", message: "连接已恢复" });
      return snapshot;
    } catch (error) {
      signal.throwIfAborted();
      last = error;
    }
  }
  throw new MonitorError(
    "connection_lost",
    `连接无法恢复：${(last as Error)?.message || "后端不可用"}；不会重放任务`
  );
}

/** Subscribe before submitting so even a run finishing before its ACK is observed. */
export async function waitForRun(
  client: MonitoringClient,
  profile: string,
  options: {
    runId?: string;
    submit?: () => Promise<unknown>;
    timeoutMs?: number;
    signal?: AbortSignal;
    followLogs?: boolean;
    pollIntervalMs?: number;
    onEvent?: (event: MonitorEvent) => void;
  } = {}
): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000)
    throw new Error("等待时限必须在 1 毫秒到 24 小时之间");
  const clock = deadline(options.signal, timeoutMs);
  const signal = clock.signal;
  const observed = new Map<string, { status: RunStatus; runningSeen: boolean }>();
  let disconnected = false;
  let accepting = !options.submit;
  let latest: RunStatus | undefined;
  let lastDisplay = "";
  const record = (snapshot: StatusSnapshot) => {
    if (signal.aborted || !accepting || !snapshot[profile]) return;
    const state = structuredClone(snapshot[profile]);
    const key = state.run_id || "legacy";
    const prior = observed.get(key);
    if (
      prior &&
      typeof prior.status.timestamp === "number" &&
      typeof state.timestamp === "number" &&
      state.timestamp < prior.status.timestamp
    )
      return;
    if (
      state.run_id &&
      prior?.status.running === false &&
      typeof prior.status.exit_code === "number"
    )
      return;
    latest = state;
    observed.set(key, { status: state, runningSeen: !!state.running || !!prior?.runningSeen });
    if (observed.size > 100) observed.delete(observed.keys().next().value!);
    const display = JSON.stringify(state);
    if (display !== lastDisplay) {
      options.onEvent?.({ type: "run-status", profile, status: structuredClone(state) });
      lastDisplay = display;
    }
  };
  const unsubscribeStatus = client.onStatus((_update, snapshot) => record(snapshot));
  const unsubscribeDisconnect = client.onDisconnect((error) => {
    if (signal.aborted) return;
    disconnected = true;
    options.onEvent?.({ type: "connection", state: "lost", message: error.message });
  });
  const unsubscribeLogs = options.followLogs
    ? client.onLog((entry) => {
        if (signal.aborted) return;
        if (entry.scope === `config:${profile}` || entry.scope === "global")
          options.onEvent?.({ type: "live-log", entry });
      })
    : () => {};
  try {
    signal.throwIfAborted();
    await abortable(client.connect(), signal);
    const initial = await abortable(client.status(), signal);
    let target = options.runId;
    let submission: unknown;
    let authoritativeAfterSubmission = !options.submit;
    if (options.submit) {
      accepting = true;
      signal.throwIfAborted();
      // This is intentionally called once, even when transport acknowledgement is lost.
      submission = await abortable(options.submit(), signal);
      const ack = submission as Record<string, unknown> | undefined;
      if (ack?.status === "already-running")
        throw new MonitorError(
          "already_running",
          "此配置档已有任务运行，本次任务没有提交；可使用 wait 观察现有运行",
          submission
        );
      if (typeof ack?.run_id === "string") target = ack.run_id;
    } else {
      record(initial);
      if (target && initial[profile]?.run_id !== target)
        throw new MonitorError(
          "run_not_found",
          "当前后端状态不包含指定运行编号，无法证明它已完成",
          { run_id: target, current: initial[profile] }
        );
      target ||=
        typeof initial[profile]?.run_id === "string" ? initial[profile].run_id! : undefined;
      if (!initial[profile]?.running && !target)
        throw new MonitorError(
          "no_active_run",
          "当前配置档没有可关联的运行；请先启动任务或指定运行编号"
        );
    }
    for (;;) {
      signal.throwIfAborted();
      const execution = observed.get(target || "legacy");
      if (execution && execution.status.running === false && (target || execution.runningSeen)) {
        const exit = execution.status.exit_code;
        return {
          accepted: !!options.submit,
          completed: true,
          profile,
          run_id: target || null,
          succeeded: typeof exit === "number" ? exit === 0 : null,
          status: execution.status,
          ...(submission !== undefined ? { submission } : {}),
        };
      }
      if (
        target &&
        latest?.run_id &&
        latest.run_id !== target &&
        (observed.has(target) || authoritativeAfterSubmission)
      )
        throw new MonitorError(
          "run_replaced",
          "目标运行已被另一轮运行替换，无法确认原任务的最终结果",
          { run_id: target, latest }
        );
      if (disconnected) {
        disconnected = false;
        const snapshot = await reconnect(client, signal, options.onEvent);
        record(snapshot);
        authoritativeAfterSubmission = true;
        if (
          target &&
          snapshot[profile]?.run_id !== target &&
          observed.get(target)?.status.running !== false
        )
          throw new MonitorError(
            "run_lost",
            "重连后找不到原运行编号，可能后端已重启；没有重新提交任务",
            { run_id: target }
          );
      } else {
        try {
          record(await abortable(client.status(), signal));
          authoritativeAfterSubmission = true;
        } catch (error) {
          signal.throwIfAborted();
          if (!disconnected) throw error;
        }
      }
      await pause(options.pollIntervalMs ?? 750, signal);
    }
  } finally {
    unsubscribeLogs();
    unsubscribeDisconnect();
    unsubscribeStatus();
    clock.dispose();
  }
}

/** Preserve multiplicity while combining overlapping history and live windows. */
function mergeLogWindow(
  history: BaasLogEntry[],
  live: BaasLogEntry[],
  key: (entry: BaasLogEntry) => string
): BaasLogEntry[] {
  const width = live.length + 1;
  const matches = new Uint16Array((history.length + 1) * width);
  const historyKeys = history.map(key),
    liveKeys = live.map(key);
  for (let i = history.length - 1; i >= 0; i--)
    for (let j = live.length - 1; j >= 0; j--) {
      matches[i * width + j] =
        historyKeys[i] === liveKeys[j]
          ? matches[(i + 1) * width + j + 1] + 1
          : Math.max(matches[(i + 1) * width + j], matches[i * width + j + 1]);
    }
  const merged: BaasLogEntry[] = [];
  let i = 0,
    j = 0;
  while (i < history.length && j < live.length) {
    if (historyKeys[i] === liveKeys[j]) {
      merged.push(history[i++]);
      j++;
    } else if (matches[(i + 1) * width + j] >= matches[i * width + j + 1])
      merged.push(history[i++]);
    else merged.push(live[j++]);
  }
  return merged.concat(history.slice(i), live.slice(j));
}

/** Follow logs with bounded overlap recovery across a read-only reconnect. */
export async function followLogs(
  client: MonitoringClient,
  options: {
    profile?: string;
    limit?: number;
    signal: AbortSignal;
    onEvent: (event: MonitorEvent) => void;
  }
): Promise<void> {
  const limit = options.limit ?? 30;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500)
    throw new Error("日志条数必须是 1 到 500 的整数");
  let disconnected = false;
  let collecting = true;
  let epoch = 0;
  let queued: BaasLogEntry[] = [];
  const emitted: BaasLogEntry[] = [];
  const relevant = (entry: BaasLogEntry) =>
    !options.profile || entry.scope === `config:${options.profile}`;
  const emit = (entry: BaasLogEntry) => {
    options.signal.throwIfAborted();
    if (!relevant(entry)) return;
    const stored = structuredClone(entry);
    emitted.push(stored);
    if (emitted.length > 500) emitted.shift();
    options.onEvent({ type: "live-log", entry: structuredClone(stored) });
  };
  const key = (entry: BaasLogEntry) =>
    JSON.stringify([entry.time, entry.scope, entry.level, entry.message]);
  const unsubscribe = client.onLog((entry) => {
    if (options.signal.aborted || !relevant(entry)) return;
    if (collecting) {
      queued.push(structuredClone(entry));
      if (queued.length > 2000) queued.shift();
    } else emit(entry);
  });
  const offDisconnect = client.onDisconnect((error) => {
    if (options.signal.aborted) return;
    disconnected = true;
    collecting = true;
    epoch++;
    options.onEvent({ type: "connection", state: "lost", message: error.message });
  });
  const catchUp = async (initial: boolean): Promise<boolean> => {
    collecting = true;
    const readingEpoch = epoch;
    const history = (
      await abortable(client.logs(initial ? limit : 500, options.profile), options.signal)
    )
      .filter(relevant)
      .slice(-500);
    if (readingEpoch !== epoch) return false;
    // A larger reconnect window can include entries older than the initial
    // display. Locate the longest emitted suffix anywhere in that window.
    let start = 0;
    search: for (let size = Math.min(emitted.length, history.length); size > 0; size--) {
      for (let offset = 0; offset + size <= history.length; offset++) {
        if (
          emitted.slice(-size).every((entry, index) => key(entry) === key(history[offset + index]))
        ) {
          start = offset + size;
          break search;
        }
      }
    }
    const duringRead = queued;
    queued = [];
    for (const entry of mergeLogWindow(history.slice(start), duringRead, key)) emit(entry);
    if (readingEpoch !== epoch) return false;
    collecting = false;
    const afterRead = queued;
    queued = [];
    for (const entry of afterRead) emit(entry);
    return true;
  };
  try {
    options.signal.throwIfAborted();
    await abortable(client.connect(), options.signal);
    try {
      await catchUp(true);
    } catch (error) {
      options.signal.throwIfAborted();
      if (!disconnected) throw error;
    }
    for (;;) {
      options.signal.throwIfAborted();
      if (disconnected) {
        disconnected = false;
        collecting = true;
        await reconnect(client, options.signal, options.onEvent, async () => {
          if (!(await catchUp(false))) throw new Error("日志读取期间连接再次中断");
        });
      }
      await pause(300, options.signal);
    }
  } finally {
    unsubscribe();
    offDisconnect();
  }
}

/** Stream provider status changes, with a slow read fallback for older peers. */
export async function watchStatus(
  client: MonitoringClient,
  options: {
    profile?: string;
    signal: AbortSignal;
    onEvent: (event: MonitorEvent) => void;
    pollIntervalMs?: number;
  }
): Promise<void> {
  const interval = options.pollIntervalMs ?? 2000;
  if (!Number.isFinite(interval) || interval < 1 || interval > 60_000)
    throw new Error("状态轮询间隔必须是 1 到 60000 毫秒");
  let disconnected = false;
  const displayed = new Map<string, string>();
  const record = (snapshot: StatusSnapshot) => {
    if (options.signal.aborted) return;
    for (const [profile, status] of Object.entries(snapshot)) {
      if (options.profile && profile !== options.profile) continue;
      const signature = JSON.stringify(status);
      if (displayed.get(profile) === signature) continue;
      displayed.set(profile, signature);
      options.onEvent({ type: "run-status", profile, status: structuredClone(status) });
    }
  };
  const offStatus = client.onStatus((_update, snapshot) => record(snapshot));
  const offDisconnect = client.onDisconnect((error) => {
    if (options.signal.aborted) return;
    disconnected = true;
    options.onEvent({ type: "connection", state: "lost", message: error.message });
  });
  try {
    options.signal.throwIfAborted();
    try {
      await abortable(client.connect(), options.signal);
      record(await abortable(client.status(), options.signal));
    } catch (error) {
      options.signal.throwIfAborted();
      if (!disconnected) throw error;
    }
    for (;;) {
      options.signal.throwIfAborted();
      if (disconnected) {
        disconnected = false;
        record(await reconnect(client, options.signal, options.onEvent));
      }
      await pause(interval, options.signal);
      if (disconnected) continue;
      try {
        record(await abortable(client.status(), options.signal));
      } catch (error) {
        options.signal.throwIfAborted();
        if (!disconnected) throw error;
      }
    }
  } finally {
    offStatus();
    offDisconnect();
  }
}

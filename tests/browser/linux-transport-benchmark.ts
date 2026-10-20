// Development-only benchmark loaded explicitly through the local WebKit inspector.
// It exercises the real store and status command without starting game tasks.
import { useWebSocketStore } from "../../src/store/WebsocketStore";
import type { BackendTransportMode } from "../../src/transport/types";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const encoder = new TextEncoder();
let timestamp = Date.now();
let running = false;

export function state() {
  const store = useWebSocketStore.getState();
  return {
    mode: store.transportMode,
    auth: store._auth_phase,
    error: store._auth_error,
    ready: store._all_data_initialized,
    configCount: Object.keys(store.configStore).length,
    statusCount: Object.keys(store.statusStore).length,
    channels: Object.fromEntries(
      Object.entries(store.connections).map(([key, connection]) => [key, connection?.readyState])
    ),
    visibility: document.visibilityState,
    focused: document.hasFocus(),
  };
}

async function waitFor(predicate: () => boolean, timeout = 45_000) {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() > deadline) {
      throw new Error(`Benchmark readiness timeout: ${JSON.stringify(state())}`);
    }
    await delay(25);
  }
}

function healthy(mode: BackendTransportMode) {
  const current = state();
  return (
    current.mode === mode &&
    current.auth === "authenticated" &&
    current.ready &&
    ["provider", "sync", "trigger"].every((key) => current.channels[key] === 1)
  );
}

async function command(): Promise<Record<string, unknown>> {
  timestamp = Math.max(timestamp + 1, Date.now());
  const requestTimestamp = timestamp;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      delete useWebSocketStore.getState().pendingCallbacks[requestTimestamp];
      reject(new Error("status command timed out"));
    }, 10_000);
    useWebSocketStore.getState().trigger(
      { command: "status", payload: {}, timestamp: requestTimestamp },
      (response) => {
        clearTimeout(timer);
        if (response.status !== "ok") reject(new Error(JSON.stringify(response)));
        else resolve(response);
      }
    );
  });
}

function summary(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  return {
    count: sorted.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    minMs: sorted[0],
    maxMs: sorted.at(-1),
    meanMs: samples.reduce((a, b) => a + b, 0) / samples.length,
  };
}

export async function run(options: {
  orders?: BackendTransportMode[][];
  samples?: number;
  warmup?: number;
  settleMs?: number;
  blockSize?: number;
} = {}) {
  if (running) throw new Error("A benchmark is already running");
  running = true;
  const orders = options.orders ?? [
    ["websocket", "pipe", "shm"],
    ["pipe", "shm", "websocket"],
    ["shm", "websocket", "pipe"],
    ["shm", "pipe", "websocket"],
    ["pipe", "websocket", "shm"],
    ["websocket", "shm", "pipe"],
  ];
  const count = options.samples ?? 300;
  const warmup = options.warmup ?? 50;
  const settleMs = options.settleMs ?? 1_000;
  const blockSize = options.blockSize ?? 25;
  const rounds: Array<Record<string, unknown> & { mode: BackendTransportMode; samplesMs: number[] }> = [];
  const failures: Array<Record<string, unknown>> = [];
  let restoreError: string | undefined;
  const began = new Date().toISOString();
  try {
    await waitFor(() => healthy(useWebSocketStore.getState().transportMode));
    for (const [round, order] of orders.entries()) {
      for (const mode of order) {
        try {
          await useWebSocketStore.getState().setTransportMode(mode);
          await useWebSocketStore.getState().init();
          await waitFor(() => healthy(mode));
          await delay(settleMs);
          if (document.visibilityState !== "visible") throw new Error("The benchmark window is hidden");
          for (let i = 0; i < warmup; i++) await command();
          const before = state();
          const connections = useWebSocketStore.getState().connections;
          const responseBytes = new Set<number>();
          const responseData = new Set<string>();
          const samplesMs: number[] = [];
          const blocks: Array<{ count: number; elapsedMs: number; meanMs: number }> = [];
          for (let i = 0; i < count; i += blockSize) {
            const responses: Record<string, unknown>[] = [];
            const blockCount = Math.min(blockSize, count - i);
            const blockStarted = performance.now();
            for (let j = 0; j < blockCount; j++) {
              const started = performance.now();
              const response = await command();
              samplesMs.push(performance.now() - started);
              responses.push(response);
            }
            const elapsedMs = performance.now() - blockStarted;
            blocks.push({ count: blockCount, elapsedMs, meanMs: elapsedMs / blockCount });
            // Validation/serialization are outside both timers.
            for (const response of responses) {
              responseBytes.add(encoder.encode(JSON.stringify(response)).byteLength);
              responseData.add(JSON.stringify(response.data));
            }
            if (!healthy(mode) || document.visibilityState !== "visible") {
              throw new Error("Mode, connection, readiness or visibility changed during sampling");
            }
            const current = useWebSocketStore.getState().connections;
            if ((["provider", "sync", "trigger"] as const).some((key) => current[key] !== connections[key])) {
              throw new Error("A business connection was replaced during sampling");
            }
          }
          if (responseData.size !== 1) throw new Error("status response data changed during sampling");
          const result = {
            round: round + 1,
            mode,
            before,
            after: state(),
            responseBytes: [...responseBytes],
            responseData: JSON.parse([...responseData][0]),
            samplesMs,
            blocks,
            summary: {
              ...summary(samplesMs),
              serialMeanMs: blocks.reduce((sum, block) => sum + block.elapsedMs, 0) / count,
            },
          };
          rounds.push(result);
          console.info(`[linux-transport-bench] round=${round + 1} mode=${mode} ${JSON.stringify(result.summary)}`);
        } catch (error) {
          failures.push({ round: round + 1, mode, error: String(error), state: state() });
          throw error;
        }
      }
    }
  } catch (error) {
    console.error("[linux-transport-bench] failed", error);
  } finally {
    try {
      await useWebSocketStore.getState().setTransportMode("shm");
      await useWebSocketStore.getState().init();
      await waitFor(() => healthy("shm"));
    } catch (error) {
      restoreError = String(error);
    }
    running = false;
  }
  return {
    scope: "Actual Linux Tauri WebView status command RTT; product SecureWebSocket includes encryption",
    began,
    finished: new Date().toISOString(),
    environment: { userAgent: navigator.userAgent, platform: navigator.platform, href: location.href },
    options: { orders, samples: count, warmup, settleMs, blockSize, concurrency: 1 },
    rounds,
    summary: Object.fromEntries(
      (["websocket", "pipe", "shm"] as const).map((mode) => {
        const values = rounds.filter((round) => round.mode === mode).flatMap((round) => round.samplesMs);
        const blocks = rounds.filter((round) => round.mode === mode).flatMap((round) => round.blocks as Array<{ count: number; elapsedMs: number }>);
        return [mode, values.length ? {
          ...summary(values),
          serialMeanMs: blocks.reduce((sum, block) => sum + block.elapsedMs, 0) / values.length,
        } : null];
      })
    ),
    failures,
    restoreError: restoreError ?? null,
    finalState: state(),
  };
}

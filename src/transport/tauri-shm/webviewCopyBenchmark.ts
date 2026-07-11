type IpcBenchmarkMessage = {
  channel: string;
  name: string;
  streamId: number;
  kind: "json" | "bytes" | "close" | "error";
  sequenceNumber: number;
  bytes?: number[];
};

type RustBenchmarkResult = {
  payloadSize: number;
  iterations: number;
  rustEmitMs: number;
  totalBytes: number;
};

export type WebviewCopyBenchmarkOptions = {
  payloadSizes?: number[];
  iterations?: number;
  timeoutMs?: number;
};

export type WebviewCopyBenchmarkResult = RustBenchmarkResult & {
  webviewWallMs: number;
  webviewMiBs: number;
  receivedMessages: number;
};

const DEFAULT_PAYLOAD_SIZES = [1024, 64 * 1024, 1024 * 1024];

export async function benchmarkTauriWebviewCopy(
  options: WebviewCopyBenchmarkOptions = {}
): Promise<WebviewCopyBenchmarkResult[]> {
  const { Channel, invoke } = await import("@tauri-apps/api/core");
  const payloadSizes = options.payloadSizes ?? DEFAULT_PAYLOAD_SIZES;
  const iterations = options.iterations ?? 60;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const results: WebviewCopyBenchmarkResult[] = [];

  for (const payloadSize of payloadSizes) {
    let receivedMessages = 0;
    let receivedBytes = 0;
    const started = performance.now();
    let rustResultPromise: Promise<RustBenchmarkResult>;
    const received = new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        reject(new Error(`timed out waiting for ${iterations} benchmark messages`));
      }, timeoutMs);
      const channel = new Channel<IpcBenchmarkMessage>((message) => {
        if (message.kind !== "bytes") return;
        receivedMessages += 1;
        receivedBytes += message.bytes?.length ?? 0;
        if (receivedMessages === iterations) {
          window.clearTimeout(timeout);
          resolve();
        }
      });
      rustResultPromise = invoke<RustBenchmarkResult>("backend_ipc_benchmark_webview_copy", {
        request: { payloadSize, iterations },
        onMessage: channel,
      });
      void rustResultPromise.catch((error: unknown) => {
        window.clearTimeout(timeout);
        reject(error);
      });
    });

    const [rustResult] = await Promise.all([rustResultPromise!, received]);
    const webviewWallMs = performance.now() - started;
    if (receivedBytes !== rustResult.totalBytes) {
      throw new Error(`received ${receivedBytes} bytes, expected ${rustResult.totalBytes}`);
    }
    results.push({
      ...rustResult,
      webviewWallMs,
      webviewMiBs: receivedBytes / 1024 / 1024 / (webviewWallMs / 1000),
      receivedMessages,
    });
  }

  return results;
}

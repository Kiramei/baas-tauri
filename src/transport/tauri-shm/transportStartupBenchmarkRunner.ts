import { invoke } from "@tauri-apps/api/core";

type StartupBenchmarkConfig = {
  outputPath: string;
  mode: "shared-memory" | "websocket";
};

type BenchmarkReport = {
  success: boolean;
  results?: Record<string, unknown>;
  error?: string;
};

export async function runConfiguredTransportStartupBenchmark(): Promise<boolean> {
  const config = await invoke<StartupBenchmarkConfig | null>(
    "backend_transport_startup_benchmark_config"
  );
  if (!config) return false;

  const finish = (report: BenchmarkReport) =>
    invoke("backend_ipc_finish_webview_benchmark", { report });
  const started = performance.now();
  try {
    const status =
      config.mode === "websocket"
        ? await invoke<Record<string, unknown>>("backend_websocket_start")
        : await invoke<Record<string, unknown>>("backend_ipc_start");
    await finish({
      success: true,
      results: {
        mode: config.mode,
        readyMs: performance.now() - started,
        status,
      },
    });
  } catch (error) {
    await finish({
      success: false,
      error: error instanceof Error ? error.message : String(error),
      results: {
        mode: config.mode,
        elapsedMs: performance.now() - started,
      },
    });
  }
  return true;
}

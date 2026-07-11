import { invoke } from "@tauri-apps/api/core";

import { benchmarkTauriWebviewCopy, type WebviewCopyBenchmarkResult } from "./webviewCopyBenchmark";

type WebviewCopyBenchmarkRunConfig = {
  outputPath: string;
  payloadSizes: number[];
  iterations: number;
  timeoutMs: number;
};

type WebviewCopyBenchmarkReport = {
  success: boolean;
  results?: WebviewCopyBenchmarkResult[];
  error?: string;
};

export async function runConfiguredWebviewCopyBenchmark(): Promise<boolean> {
  const config = await invoke<WebviewCopyBenchmarkRunConfig | null>(
    "backend_ipc_webview_benchmark_config"
  );
  if (!config) return false;

  const finish = async (report: WebviewCopyBenchmarkReport) => {
    await invoke("backend_ipc_finish_webview_benchmark", { report });
  };

  try {
    const results = await benchmarkTauriWebviewCopy({
      payloadSizes: config.payloadSizes,
      iterations: config.iterations,
      timeoutMs: config.timeoutMs,
    });
    await finish({ success: true, results });
  } catch (error) {
    await finish({
      success: false,
      error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
    });
  }

  return true;
}

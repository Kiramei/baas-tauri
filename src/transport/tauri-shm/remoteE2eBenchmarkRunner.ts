import { invoke } from "@tauri-apps/api/core";

import { CommandControlMessage, ControlMessage } from "@/components/remote/MessageCenter";
import { VideoSettings } from "@/components/remote/CommonUtil";
import { Size } from "@/components/remote/GeometryInfo";
import { StreamReceiver, WSMiddleware } from "@/components/remote/StreamClientScrcpy";
import { TauriSharedMemoryTransport } from "./TauriSharedMemoryTransport";

type RemoteBenchmarkConfig = {
  outputPath: string;
  configId: string;
  durationMs: number;
  timeoutMs: number;
};

type RemoteBenchmarkResult = {
  configId: string;
  transportStartMs: number;
  channelConnectMs: number;
  firstStatusMs: number | null;
  initialInfoMs: number;
  firstVideoMs: number;
  controlSendMs: number;
  controlRoundTripMs: number | null;
  sampleDurationMs: number;
  binaryMessages: number;
  videoMessages: number;
  videoBytes: number;
  videoMiBs: number;
  displayCount: number;
  deviceName: string;
  statuses: string[];
};

type BenchmarkReport = {
  success: boolean;
  results?: RemoteBenchmarkResult;
  error?: string;
};

export async function runConfiguredRemoteE2eBenchmark(): Promise<boolean> {
  const config = await invoke<RemoteBenchmarkConfig | null>("backend_ipc_remote_benchmark_config");
  if (!config) return false;

  const finish = async (report: BenchmarkReport) => {
    await invoke("backend_ipc_finish_webview_benchmark", { report });
  };

  try {
    await finish({ success: true, results: await benchmarkRemote(config) });
  } catch (error) {
    await finish({
      success: false,
      error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
    });
  }
  return true;
}

async function benchmarkRemote(config: RemoteBenchmarkConfig): Promise<RemoteBenchmarkResult> {
  const started = performance.now();
  const transport = new TauriSharedMemoryTransport();
  let connection: Awaited<ReturnType<TauriSharedMemoryTransport["openChannel"]>> | null = null;
  const statuses: string[] = [];
  let transportStartMs = 0;
  let channelConnectMs = 0;
  let firstStatusMs: number | null = null;
  let initialInfoMs = 0;
  let firstVideoMs = 0;
  let controlSentAt = 0;
  let controlSendMs = 0;
  let controlRoundTripMs: number | null = null;
  let binaryMessages = 0;
  let videoMessages = 0;
  let videoBytes = 0;
  let displayCount = 0;
  let deviceName = "";

  try {
    await transport.start();
    transportStartMs = performance.now() - started;
    connection = await transport.openChannel("remote", {
      name: `remote-benchmark-${crypto.randomUUID()}`,
      binaryType: "arraybuffer",
    });
    const middleware = new WSMiddleware(connection);
    middleware.bindSender((payload) => connection!.sendBytes(payload));
    const receiver = new StreamReceiver(middleware);

    const completed = new Promise<void>((resolve, reject) => {
      let sampleTimer: number | null = null;
      const timeout = window.setTimeout(() => {
        reject(
          new Error(
            `remote benchmark timed out after ${config.timeoutMs} ms ` +
              `(initialInfoMs=${initialInfoMs.toFixed(1)}, firstVideoMs=${firstVideoMs.toFixed(1)}, ` +
              `controlSendMs=${controlSendMs.toFixed(1)}, binaryMessages=${binaryMessages}, ` +
              `videoMessages=${videoMessages}, statuses=${statuses.join(" | ")})`
          )
        );
      }, config.timeoutMs);
      const maybeResolve = () => {
        if (!firstVideoMs || !initialInfoMs || !controlSendMs || sampleTimer !== null) return;
        sampleTimer = window.setTimeout(() => {
          window.clearTimeout(timeout);
          resolve();
        }, config.durationMs);
      };

      receiver.on("video", (frame) => {
        videoMessages += 1;
        videoBytes += frame.byteLength;
        if (!firstVideoMs) firstVideoMs = performance.now() - started;
        maybeResolve();
      });
      receiver.on("displayInfo", (displays) => {
        displayCount = displays.length;
        if (!initialInfoMs) initialInfoMs = performance.now() - started;
        if (!controlSentAt) {
          controlSentAt = performance.now();
          const display = displays[0];
          const videoSettings = display?.videoSettings ?? new VideoSettings({
            bitrate: 8_000_000,
            bounds: new Size(1280, 720),
            maxFps: 30,
            iFrameInterval: 10,
            displayId: display?.displayInfo.displayId ?? 0,
          });
          void Promise.resolve(
            Promise.all([
              connection!.sendBytes(
                CommandControlMessage.createSetVideoSettingsCommand(videoSettings).toBuffer()
              ),
              connection!.sendBytes(
                new CommandControlMessage(ControlMessage.TYPE_GET_CLIPBOARD).toBuffer()
              ),
            ])
          ).then(() => {
            controlSendMs = performance.now() - controlSentAt;
            maybeResolve();
          }, reject);
        }
        maybeResolve();
      });
      receiver.on("clientsStats", (stats) => {
        deviceName = stats.deviceName;
      });
      receiver.on("deviceMessage", () => {
        if (controlSentAt && controlRoundTripMs === null) {
          controlRoundTripMs = performance.now() - controlSentAt;
        }
        maybeResolve();
      });
      receiver.on("disconnected", (event) => {
        reject(new Error(`remote disconnected before benchmark completed: ${event.reason}`));
      });

      connection!.onOpen = (event) => middleware.dispatchEvent("open", event);
      connection!.onClose = (event) => middleware.dispatchEvent("close", event);
      connection!.onError = (event) =>
        reject(
          new Error(
            event instanceof ErrorEvent && event.message
              ? event.message
              : "remote transport reported an error"
          )
        );
      void connection!
        .connect((message: ArrayBuffer | Record<string, unknown>) => {
          if (message instanceof ArrayBuffer) {
            binaryMessages += 1;
            middleware.dispatchEvent("message", new MessageEvent("message", { data: message }));
            return;
          }
          const type = String(message?.type ?? "");
          const text = String(message?.message ?? message?.error ?? type);
          statuses.push(text);
          if (firstStatusMs === null) firstStatusMs = performance.now() - started;
          if (type === "remote_error") reject(new Error(text));
        })
        .then(async () => {
          channelConnectMs = performance.now() - started;
          await connection!.sendJson({ config_id: config.configId, decrypt: false });
        })
        .catch(reject);
    });

    await completed;
    const sampleDurationMs = Math.max(performance.now() - started - firstVideoMs, 1);
    return {
      configId: config.configId,
      transportStartMs,
      channelConnectMs,
      firstStatusMs,
      initialInfoMs,
      firstVideoMs,
      controlSendMs,
      controlRoundTripMs,
      sampleDurationMs,
      binaryMessages,
      videoMessages,
      videoBytes,
      videoMiBs: videoBytes / 1024 / 1024 / (sampleDurationMs / 1000),
      displayCount,
      deviceName,
      statuses,
    };
  } finally {
    await Promise.resolve(connection?.close()).catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

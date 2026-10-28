// Development-only probe, loaded by the native WebView through Vite/CDP.
// Uses the real store, backend commands, RemoteDisplay, and video player.
import { useWebSocketStore } from "../../src/store/WebsocketStore";
import { StreamClientScrcpy } from "../../src/components/remote/StreamClientScrcpy";
import { TouchControlMessage } from "../../src/components/remote/MessageCenter";
import { Point, Position, Size } from "../../src/components/remote/GeometryInfo";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let timestamp = Date.now();
let player: any;
let client: StreamClientScrcpy | undefined;
let remoteStartedAt = 0;
let remoteBytes = 0;
let remotePackets = 0;
let firstPacketMs: number | null = null;
let remoteConnection: any;
let originalConnectRemote: any;
let restoreStart: (() => void) | undefined;

export function state() {
  const value = useWebSocketStore.getState();
  return {
    mode: value.transportMode, auth: value._auth_phase, error: value._auth_error,
    ready: value._all_data_initialized, configs: Object.keys(value.configStore),
    channels: Object.keys(value.connections), statuses: value.statusStore,
  };
}

export function logs(configId: string, count = 50) {
  return useWebSocketStore.getState().logStore[`config:${configId}`]?.slice(-count) ?? [];
}

export async function locale() {
  const { loadLocale } = await import("../../src/shared/I18nTranslator");
  const { default: Storage } = await import("../../src/shared/StorageManager");
  Storage.set("uiSettings", { ...Storage.get("uiSettings"), lang: "zh" });
  await loadLocale("zh");
  return { language: "zh" };
}

async function waitFor(predicate: () => boolean, timeout = 30_000) {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`Live validation timeout: ${JSON.stringify(state())}`);
    await delay(10);
  }
}

export async function command(command: string, payload: any = {}, configId?: string) {
  timestamp = Math.max(timestamp + 1, Date.now());
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Command ${command} timeout`)), 30_000);
    useWebSocketStore.getState().trigger({ command, payload, config_id: configId, timestamp }, (response) => {
      clearTimeout(timer);
      if (response.status === "error") reject(new Error(response.error ?? JSON.stringify(response)));
      else resolve(response);
    });
  });
}

export async function measureCommands(count = 50) {
  await command("status");
  const samplesMs = [];
  for (let index = 0; index < count; index++) {
    const start = performance.now();
    await command("status");
    samplesMs.push(performance.now() - start);
  }
  const sorted = [...samplesMs].sort((a, b) => a - b);
  return { samplesMs, p50Ms: sorted[Math.floor(count * .5)], p95Ms: sorted[Math.floor(count * .95)] };
}

export async function runTask(configId: string, task: "restart" | "mail") {
  const started = performance.now();
  let running = false;
  let complete: any;
  const unsubscribe = useWebSocketStore.subscribe((value) => {
    const status = value.statusStore[configId];
    if (status?.running) running = true;
    if (running && status?.running === false) complete = { ...status };
  });
  try {
    const response = await command("solve", { task }, configId);
    const acceptedMs = performance.now() - started;
    await waitFor(() => Boolean(complete), 120_000);
    if (complete.exit_code != null && complete.exit_code !== 0) throw new Error(`Task failed: ${JSON.stringify(complete)}`);
    return { task, acceptedMs, completeMs: performance.now() - started, status: complete, response };
  } finally { unsubscribe(); }
}

export async function switchMode(mode: "websocket" | "pipe" | "shm") {
  stopRemote();
  const started = performance.now();
  await useWebSocketStore.getState().setTransportMode(mode);
  await waitFor(() => useWebSocketStore.getState()._auth_phase === "authenticated");
  await useWebSocketStore.getState().init();
  await waitFor(() => useWebSocketStore.getState()._all_data_initialized);
  return { mode, readyMs: performance.now() - started, state: state() };
}

export async function startRemote() {
  remoteBytes = 0; remotePackets = 0; firstPacketMs = null;
  originalConnectRemote = useWebSocketStore.getState().connectRemote;
  useWebSocketStore.setState({ connectRemote: async () => {
    const connection = await originalConnectRemote();
    remoteConnection = connection;
    const connect = connection.connect.bind(connection);
    connection.connect = (receive: (data: any) => void, ...options: any[]) => connect((data: any) => {
      if (data instanceof ArrayBuffer) {
        remoteBytes += data.byteLength; remotePackets++;
        firstPacketMs ??= performance.now() - remoteStartedAt;
      }
      receive(data);
    }, ...options);
    return connection;
  }});
  const start = StreamClientScrcpy.start;
  (StreamClientScrcpy as any).start = (...args: any[]) => {
    player = args[1];
    client = start.apply(StreamClientScrcpy, args as any);
    return client;
  };
  restoreStart = () => { StreamClientScrcpy.start = start; };
  const button = [...document.querySelectorAll("svg.lucide-webcam")]
    .map((svg) => svg.closest("button"))
    .find((button) => button && button.getClientRects().length);
  if (!button) throw new Error("Actual HomePage remote toggle was not found");
  remoteStartedAt = performance.now();
  button.click();
  await waitFor(() => Boolean(player && client && view()?.width), 30_000);
  await waitFor(() => frameCount() > 0, 30_000);
  const firstDecodedMs = performance.now() - remoteStartedAt;
  const element = view()?.element;
  if (element instanceof HTMLVideoElement) {
    await Promise.race([
      new Promise<void>((resolve) => element.requestVideoFrameCallback(() => resolve())),
      delay(5_000).then(() => { throw new Error("Remote video did not present a frame"); }),
    ]);
  }
  return { firstPacketMs, firstDecodedMs, firstRenderedMs: performance.now() - remoteStartedAt, width: view()?.width, height: view()?.height };
}

function view(): any {
  const element = player?.tag;
  if (!element) return undefined;
  return element instanceof HTMLVideoElement
    ? { element, width: element.videoWidth, height: element.videoHeight }
    : { element, width: element.width, height: element.height };
}

function frameCount() {
  const element = view()?.element;
  if (element instanceof HTMLVideoElement) return element.getVideoPlaybackQuality().totalVideoFrames;
  return player?.totalStats?.decodedFrames ?? 0;
}

export async function measureRemote(seconds = 15) {
  const element = view()?.element;
  if (!element) throw new Error("No remote player");
  const start = performance.now(), startFrames = frameCount();
  const startBytes = remoteBytes, startPackets = remotePackets;
  const initialQuality = element instanceof HTMLVideoElement ? element.getVideoPlaybackQuality() : null;
  let callbacks = 0, firstPresented: number | undefined, lastPresented: number | undefined;
  let lastCallback: number | undefined, callbackId: number | undefined;
  const frameGapsMs: number[] = [];
  const presented = (now: number, metadata: VideoFrameCallbackMetadata) => {
    callbacks++;
    firstPresented ??= metadata.presentedFrames;
    lastPresented = metadata.presentedFrames;
    if (lastCallback !== undefined) frameGapsMs.push(now - lastCallback);
    lastCallback = now;
    callbackId = element.requestVideoFrameCallback(presented);
  };
  if (element instanceof HTMLVideoElement) callbackId = element.requestVideoFrameCallback(presented);
  await delay(seconds * 1000);
  if (callbackId !== undefined) element.cancelVideoFrameCallback(callbackId);
  const elapsedSeconds = (performance.now() - start) / 1000;
  const finalQuality = element instanceof HTMLVideoElement ? element.getVideoPlaybackQuality() : null;
  const frames = frameCount() - startFrames;
  return {
    elapsedSeconds, videoTotalFrames: frames, videoTotalFps: frames / elapsedSeconds,
    presentationCallbacks: callbacks,
    presentedFrames: firstPresented !== undefined && lastPresented !== undefined ? lastPresented - firstPresented + 1 : null,
    presentedFps: firstPresented !== undefined && lastPresented !== undefined ? (lastPresented - firstPresented + 1) / elapsedSeconds : null,
    frameGapP95Ms: [...frameGapsMs].sort((a,b)=>a-b)[Math.floor(frameGapsMs.length*.95)],
    receivedBytes: remoteBytes - startBytes, receivedPackets: remotePackets - startPackets,
    droppedFrames: finalQuality && initialQuality ? finalQuality.droppedVideoFrames - initialQuality.droppedVideoFrames : null,
    readyState: element.readyState, currentTime: element.currentTime,
    player: player?.constructor?.name, width: view()?.width, height: view()?.height,
  };
}

function pixels(rect: [number, number, number, number]) {
  const source = view();
  if (!source) throw new Error("Remote view unavailable");
  const canvas = document.createElement("canvas"); canvas.width = rect[2]; canvas.height = rect[3];
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.drawImage(source.element, ...rect, 0, 0, rect[2], rect[3]);
  return context.getImageData(0, 0, rect[2], rect[3]).data;
}

export function remoteRegion(rect: [number, number, number, number]) {
  const data = pixels(rect);
  const sums = [0, 0, 0];
  let bluePixels = 0;
  for (let index = 0; index < data.length; index += 4) {
    for (let channel = 0; channel < 3; channel++) sums[channel] += data[index + channel];
    if (data[index + 2] > data[index] + 70 && data[index + 1] > data[index] + 30) bluePixels++;
  }
  return { meanRgb: sums.map(sum => sum / (data.length / 4)), bluePixelRatio: bluePixels / (data.length / 4) };
}

export async function tapAndMeasure(x: number, y: number, rect: [number, number, number, number], threshold = 25) {
  if (!client) throw new Error("No actual remote client");
  const source = view(), baseline = pixels(rect);
  const position = new Position(new Point(x, y), new Size(source.width, source.height));
  const started = performance.now();
  client.sendMessage(new TouchControlMessage(0, 0, position, 1, 1));
  client.sendMessage(new TouchControlMessage(1, 0, position, 0, 0));
  const deadline = started + 5_000;
  while (performance.now() < deadline) {
    await new Promise(requestAnimationFrame);
    const current = pixels(rect);
    let difference = 0;
    for (let index = 0; index < current.length; index += 4) {
      difference += Math.abs(current[index] - baseline[index]) + Math.abs(current[index+1] - baseline[index+1]) + Math.abs(current[index+2] - baseline[index+2]);
    }
    const meanRgbDifference = difference / (current.length / 4 * 3);
    if (meanRgbDifference > threshold) return { x, y, responseMs: performance.now() - started, meanRgbDifference, rect };
  }
  throw new Error("Remote touch did not produce the expected visible ROI change");
}

export function remoteScreenshot() {
  const source = view();
  const canvas = document.createElement("canvas"); canvas.width = source.width; canvas.height = source.height;
  canvas.getContext("2d")!.drawImage(source.element, 0, 0);
  return canvas.toDataURL("image/png");
}

export function stopRemote() {
  if (remoteConnection) {
    // Toggle the actual feature off so its effect cleans up the player/ADB stream.
    const button = [...document.querySelectorAll("svg.lucide-webcam")].map((svg) => svg.closest("button")).find((button) => button && button.getClientRects().length);
    button?.click();
  }
  restoreStart?.(); restoreStart = undefined;
  if (originalConnectRemote) useWebSocketStore.setState({ connectRemote: originalConnectRemote });
  originalConnectRemote = undefined; remoteConnection = undefined; player = undefined; client = undefined;
}

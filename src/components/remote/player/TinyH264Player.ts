import { BaseCanvasBasedPlayer } from "./BasePlayer";
import { VideoSettings } from "../CommonUtil";
import YUVWebGLCanvas from "./vendor/tinyh264/YUVWebGLCanvas";
import YUVCanvas from "./vendor/tinyh264/YUVCanvas";
import { Size, DisplayInfo } from "../GeometryInfo";
import TinyH264Worker from "./vendor/tinyh264/H264NALDecoder.worker?worker";

type WorkerMessage = {
  type: string;
  width: number;
  height: number;
  data: ArrayBuffer;
  renderStateId: number;
};

export class TinyH264Player extends BaseCanvasBasedPlayer {
  public static readonly storageKeyPrefix = "Tinyh264Decoder";
  public static readonly playerFullName = "Tiny H264";
  // noinspection JSUnusedGlobalSymbols
  public static readonly playerCodeName = "tinyh264";
  public static readonly preferredVideoSettings: VideoSettings = new VideoSettings({
    lockedVideoOrientation: -1,
    bitrate: 524288,
    maxFps: 24,
    iFrameInterval: 5,
    bounds: new Size(480, 480),
    sendFrameMeta: false,
  });
  private static videoStreamId = 1;
  protected canvas?: YUVWebGLCanvas | YUVCanvas;
  private worker?: Worker;
  private isDecoderReady = false;

  /** Handles the constructor workflow. */
  constructor(
    videoSettings: VideoSettings,
    displayInfo?: DisplayInfo,
    name = TinyH264Player.playerFullName,
    protected tag: HTMLCanvasElement = BaseCanvasBasedPlayer.createElement(),
    protected touchableCanvas: HTMLCanvasElement = document.createElement("canvas")
  ) {
    super(videoSettings, displayInfo, name, TinyH264Player.storageKeyPrefix, tag, touchableCanvas);
  }

  // noinspection JSUnusedGlobalSymbols
  public static isSupported(): boolean {
    return typeof WebAssembly === "object" && typeof WebAssembly.instantiate === "function";
  }

  /** Handles the play workflow. */
  public play(): void {
    super.play();
    if (!this.worker) {
      this.initWorker();
    }
  }

  /** Performs the stop operation. */
  public stop(): void {
    super.stop();
    if (this.worker) {
      this.worker.removeEventListener("message", this.onWorkerMessage);
      this.worker.postMessage({ type: "release", renderStateId: TinyH264Player.videoStreamId });
      delete this.worker;
    }
  }

  /** Performs the init canvas operation. */
  protected initCanvas(width: number, height: number): void {
    super.initCanvas(width, height);

    if (BaseCanvasBasedPlayer.hasWebGLSupport()) {
      this.canvas = new YUVWebGLCanvas(this.tag);
    } else {
      this.canvas = new YUVCanvas(this.tag);
    }
  }

  /** Handles the decode workflow. */
  protected decode(data: Uint8Array): void {
    if (!this.worker || !this.isDecoderReady) {
      return;
    }

    this.worker.postMessage(
      {
        type: "decode",
        data: data.buffer,
        offset: data.byteOffset,
        length: data.byteLength,
        renderStateId: TinyH264Player.videoStreamId,
      },
      [data.buffer]
    );
  }

  /** Performs the clear state operation. */
  protected clearState(): void {
    super.clearState();
    if (this.worker) {
      this.worker.postMessage({ type: "release", renderStateId: TinyH264Player.videoStreamId });
      TinyH264Player.videoStreamId++;
    }
  }

  private onWorkerMessage = (event: MessageEvent): void => {
    const message: WorkerMessage = event.data;
    switch (message.type) {
      case "pictureReady": {
        const { width, height, data } = message;
        this.onFrameDecoded(width, height, new Uint8Array(data));
        break;
      }
      case "decoderReady":
        this.isDecoderReady = true;
        break;
      default:
        console.error(`[${this.name}]`, Error(`Wrong message type "${message.type}"`));
    }
  };

  /** Performs the init worker operation. */
  private initWorker(): void {
    this.worker = new TinyH264Worker();
    this.worker.addEventListener("message", this.onWorkerMessage);
  }
}

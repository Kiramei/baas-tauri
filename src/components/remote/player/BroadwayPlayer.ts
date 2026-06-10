import { BaseCanvasBasedPlayer } from "./BasePlayer";
import { VideoSettings } from "../CommonUtil";
import { Size, DisplayInfo } from "../GeometryInfo";

import YUVCanvas from "./vendor/h264-live-player/YUVCanvas";
import YUVWebGLCanvas from "./vendor/h264-live-player/YUVWebGLCanvas";
import Canvas from "./vendor/h264-live-player/Canvas";

import Decoder, { type DecoderInstance } from "@/components/remote/player/vendor/Broadway/Decoder";

const baseUrl = import.meta.env.BASE_URL;

export class BroadwayPlayer extends BaseCanvasBasedPlayer {
  public static readonly storageKeyPrefix = "BroadwayDecoder";
  public static readonly playerFullName = "Broadway.js";

  // noinspection JSUnusedGlobalSymbols
  public static readonly playerCodeName = "broadway";

  public static readonly preferredVideoSettings: VideoSettings = new VideoSettings({
    lockedVideoOrientation: -1,
    bitrate: 524288,
    maxFps: 24,
    iFrameInterval: 5,
    bounds: new Size(480, 480),
    sendFrameMeta: false,
  });

  protected canvas?: Canvas;

  /**
   * Decoder instance.
   *
   * Do not use `typeof Decoder` here.
   * `typeof Decoder` means the constructor type, while this field stores
   * the object returned by `new Decoder(...)`.
   */
  private avc?: DecoderInstance;

  public constructor(
    videoSettings: VideoSettings,
    displayInfo?: DisplayInfo,
    name = BroadwayPlayer.playerFullName,
    protected tag: HTMLCanvasElement = BaseCanvasBasedPlayer.createElement(),
    protected touchableCanvas: HTMLCanvasElement = document.createElement("canvas")
  ) {
    super(videoSettings, displayInfo, name, BroadwayPlayer.storageKeyPrefix, tag, touchableCanvas);
  }

  // noinspection JSUnusedGlobalSymbols
  public static isSupported(): boolean {
    return typeof WebAssembly === "object" && typeof WebAssembly.instantiate === "function";
  }

  protected initCanvas(width: number, height: number): void {
    super.initCanvas(width, height);

    if (BaseCanvasBasedPlayer.hasWebGLSupport()) {
      this.canvas = new YUVWebGLCanvas(this.tag, new Size(width, height));
    } else {
      this.canvas = new YUVCanvas(this.tag, new Size(width, height));
    }

    if (!this.avc) {
      this.avc = new Decoder({
        wasmUrl: `${baseUrl}wasms/avc.wasm`,
        rgb: false,
      });
    }

    this.avc.onPictureDecoded = (
      buffer: Uint8Array,
      decodedWidth: number,
      decodedHeight: number
    ): void => {
      this.onFrameDecoded(decodedWidth, decodedHeight, buffer);
    };
  }

  protected decode(data: Uint8Array): void {
    if (!this.avc) {
      return;
    }

    this.avc.decode(data);
  }
}

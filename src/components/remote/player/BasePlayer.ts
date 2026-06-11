import { ScreenInfo, DisplayInfo } from "../GeometryInfo";
import { Rect, Size } from "../GeometryInfo";
import { DataUtil, TypedEmitter, VideoSettings } from "../CommonUtil";

interface BitrateStat {
  timestamp: number;
  bytes: number;
}

interface FramesPerSecondStats {
  avgInput: number;
  avgDecoded: number;
  avgDropped: number;
  avgSize: number;
}

export interface PlaybackQuality {
  decodedFrames: number;
  droppedFrames: number;
  inputFrames: number;
  inputBytes: number;
  timestamp: number;
}

export interface QualityParsed {
  prettyBytes: string;
  prettyAvgBytes: string;
  padInput: string;
  padAvgInput: string;
  padDropped: string;
  padAvgDropped: string;
  padDecoded: string;
  padAvgDecoded: string;
}

export interface PlayerEvents {
  "video-view-resize": Size;
  "input-video-resize": ScreenInfo;
  "video-settings": VideoSettings;
}

export interface PlayerClass {
  playerFullName: string;
  playerCodeName: string;
  storageKeyPrefix: string;
  isSupported(): boolean;
  new (videoSettings: VideoSettings, displayInfo?: DisplayInfo): BasePlayer;
}

type DecodedFrame = {
  width: number;
  height: number;
  frame: any;
};

interface CanvasDecoder {
  decode(buffer: Uint8Array, width: number, height: number): void;
}

export abstract class BasePlayer extends TypedEmitter<PlayerEvents> {
  public static readonly DEFAULT_SHOW_QUALITY_STATS = false;
  public static STATE: Record<string, number> = {
    PLAYING: 1,
    PAUSED: 2,
    STOPPED: 3,
  };
  public static storageKeyPrefix = "BaseDecoder";
  public static playerFullName = "BasePlayer";
  public static preferredVideoSettings: VideoSettings = new VideoSettings({
    lockedVideoOrientation: -1,
    bitrate: 524288,
    maxFps: 24,
    iFrameInterval: 5,
    bounds: new Size(480, 480),
    sendFrameMeta: false,
  });
  public readonly resizeVideoToBounds: boolean = false;
  protected screenInfo?: ScreenInfo;
  protected videoSettings: VideoSettings;
  protected parentElement?: HTMLElement;
  protected inputBytes: BitrateStat[] = [];
  protected perSecondQualityStats?: FramesPerSecondStats;
  protected momentumQualityStats?: PlaybackQuality;
  protected bounds: Size | null = null;
  protected receivedFirstFrame = false;
  protected videoHeight = -1;
  protected videoWidth = -1;
  private totalStats: PlaybackQuality = {
    decodedFrames: 0,
    droppedFrames: 0,
    inputFrames: 0,
    inputBytes: 0,
    timestamp: 0,
  };
  private totalStatsCounter = 0;
  private state: number = BasePlayer.STATE.STOPPED;
  private qualityAnimationId?: number;
  private showQualityStats = BasePlayer.DEFAULT_SHOW_QUALITY_STATS;

  protected constructor(
    public readonly _videoSettings: VideoSettings,
    protected displayInfo?: DisplayInfo,
    protected name: string = "BasePlayer",
    protected storageKeyPrefix: string = "Dummy",
    protected tag: HTMLElement = document.createElement("div"),
    protected touchableCanvas: HTMLCanvasElement = document.createElement("canvas")
  ) {
    super();
    this.touchableCanvas.oncontextmenu = function (event: MouseEvent): void {
      event.preventDefault();
    };
    this.videoSettings = _videoSettings;
  }

  protected static isIFrame(frame: Uint8Array): boolean {
    // last 5 bits === 5: Coded slice of an IDR picture

    // https://www.ietf.org/rfc/rfc3984.txt
    // 1.3.  Network Abstraction Layer Unit Types
    // https://www.itu.int/rec/T-REC-H.264-201906-I/en
    // Table 7-1 – NAL unit type codes, syntax element categories, and NAL unit type classes
    return frame && frame.length > 4 && (frame[4] & 31) === 5;
  }

  public abstract getImageDataURL(): string;

  public play(): void {
    if (this.needScreenInfoBeforePlay() && !this.screenInfo) {
      return;
    }
    this.state = BasePlayer.STATE.PLAYING;
  }

  public pause(): void {
    this.state = BasePlayer.STATE.PAUSED;
  }

  public stop(): void {
    this.state = BasePlayer.STATE.STOPPED;
    this.statUpdateCallback = () => undefined;
  }

  public getState(): number {
    return this.state;
  }

  public pushFrame(frame: Uint8Array): void {
    if (!this.receivedFirstFrame) {
      this.receivedFirstFrame = true;
      if (typeof this.qualityAnimationId !== "number") {
        this.qualityAnimationId = requestAnimationFrame(this.updateQualityStats);
      }
    }
    this.inputBytes.push({
      timestamp: Date.now(),
      bytes: frame.byteLength,
    });
  }

  public getTouchableElement(): HTMLCanvasElement {
    return this.touchableCanvas;
  }

  public getVideoSettings(): VideoSettings {
    return this.videoSettings;
  }

  public setVideoSettings(videoSettings: VideoSettings): void {
    this.videoSettings = videoSettings;
    this.resetStats();
    this.emit("video-settings", VideoSettings.copy(videoSettings));
  }

  public getScreenInfo(): ScreenInfo | undefined {
    return this.screenInfo;
  }

  public setScreenInfo(screenInfo: ScreenInfo): void {
    if (this.needScreenInfoBeforePlay()) {
      this.pause();
    }
    this.receivedFirstFrame = false;
    this.screenInfo = screenInfo;
    const { width, height } = screenInfo.videoSize;
    this.touchableCanvas.width = width;
    this.touchableCanvas.height = height;
    if (this.parentElement) {
      this.parentElement.style.height = `${height}px`;
      this.parentElement.style.width = `${width}px`;
    }
    const size = new Size(width, height);
    this.emit("video-view-resize", size);
  }

  public setShowQualityStats(value: boolean): void {
    this.showQualityStats = value;
    if (!value) return;
    this.drawStats();
  }

  public setDisplayInfo(displayInfo: DisplayInfo): void {
    this.displayInfo = displayInfo;
  }

  public onStatsUpdate(callback: (value: QualityParsed) => void): void {
    this.statUpdateCallback = callback;
  }

  protected calculateScreenInfoForBounds(videoWidth: number, videoHeight: number): void {
    this.videoWidth = videoWidth;
    this.videoHeight = videoHeight;
    if (this.resizeVideoToBounds) {
      let w = videoWidth;
      let h = videoHeight;
      if (this.bounds) {
        let { w: boundsWidth, h: boundsHeight } = this.bounds;
        if (w > boundsWidth || h > boundsHeight) {
          let scaledHeight;
          let scaledWidth;
          if (boundsWidth > w) {
            scaledHeight = h;
          } else {
            scaledHeight = (boundsWidth * h) / w;
          }
          if (boundsHeight > scaledHeight) {
            boundsHeight = scaledHeight;
          }
          if (boundsHeight == h) {
            scaledWidth = w;
          } else {
            scaledWidth = (boundsHeight * w) / h;
          }
          if (boundsWidth > scaledWidth) {
            boundsWidth = scaledWidth;
          }
          w = boundsWidth | 0;
          h = boundsHeight | 0;
          this.tag.style.maxWidth = `${w}px`;
          this.tag.style.maxHeight = `${h}px`;
        }
      }
      const realScreen = new ScreenInfo(new Rect(0, 0, videoWidth, videoHeight), new Size(w, h), 0);
      this.emit("input-video-resize", realScreen);
      this.setScreenInfo(new ScreenInfo(new Rect(0, 0, w, h), new Size(w, h), 0));
    }
  }

  protected abstract calculateMomentumStats(): void;

  protected needScreenInfoBeforePlay(): boolean {
    return true;
  }

  protected resetStats(): void {
    this.receivedFirstFrame = false;
    this.totalStatsCounter = 0;
    this.totalStats = {
      droppedFrames: 0,
      decodedFrames: 0,
      inputFrames: 0,
      inputBytes: 0,
      timestamp: 0,
    };
    this.perSecondQualityStats = {
      avgDecoded: 0,
      avgDropped: 0,
      avgInput: 0,
      avgSize: 0,
    };
  }

  private statUpdateCallback: (value: QualityParsed) => void = () => undefined;

  private updateQualityStats = (): void => {
    const now = Date.now();
    const oneSecondBefore = now - 1000;
    this.calculateMomentumStats();
    if (!this.momentumQualityStats) {
      return;
    }
    if (this.totalStats.timestamp < oneSecondBefore) {
      this.totalStats = {
        timestamp: now,
        decodedFrames: this.totalStats.decodedFrames + this.momentumQualityStats.decodedFrames,
        droppedFrames: this.totalStats.droppedFrames + this.momentumQualityStats.droppedFrames,
        inputFrames: this.totalStats.inputFrames + this.momentumQualityStats.inputFrames,
        inputBytes: this.totalStats.inputBytes + this.momentumQualityStats.inputBytes,
      };

      if (this.totalStatsCounter !== 0) {
        this.perSecondQualityStats = {
          avgDecoded: this.totalStats.decodedFrames / this.totalStatsCounter,
          avgDropped: this.totalStats.droppedFrames / this.totalStatsCounter,
          avgInput: this.totalStats.inputFrames / this.totalStatsCounter,
          avgSize: this.totalStats.inputBytes / this.totalStatsCounter,
        };
      }
      this.totalStatsCounter++;
    }
    this.drawStats();
    if (this.state !== BasePlayer.STATE.STOPPED) {
      this.qualityAnimationId = requestAnimationFrame(this.updateQualityStats);
    }
  };

  private drawStats(): void {
    if (!this.showQualityStats) return;
    if (this.perSecondQualityStats && this.momentumQualityStats) {
      const { decodedFrames, droppedFrames, inputBytes, inputFrames } = this.momentumQualityStats;
      const { avgDecoded, avgDropped, avgSize, avgInput } = this.perSecondQualityStats;
      const padInput = inputFrames.toString().padStart(3, " ");
      const padDecoded = decodedFrames.toString().padStart(3, " ");
      const padDropped = droppedFrames.toString().padStart(3, " ");
      const padAvgDecoded = avgDecoded.toFixed(1).padStart(5, " ");
      const padAvgDropped = avgDropped.toFixed(1).padStart(5, " ");
      const padAvgInput = avgInput.toFixed(1).padStart(5, " ");
      const prettyBytes = DataUtil.prettyBytes(inputBytes).padStart(8, " ");
      const prettyAvgBytes = DataUtil.prettyBytes(avgSize).padStart(8, " ");
      this.statUpdateCallback({
        prettyBytes: prettyBytes,
        prettyAvgBytes: prettyAvgBytes,
        padInput: padInput,
        padAvgInput: padAvgInput,
        padDropped: padDropped,
        padAvgDropped: padAvgDropped,
        padDecoded: padDecoded,
        padAvgDecoded: padAvgDecoded,
      });
    }
  }
}

export abstract class BaseCanvasBasedPlayer extends BasePlayer {
  protected framesList: Uint8Array[] = [];
  protected decodedFrames: DecodedFrame[] = [];
  protected videoStats: PlaybackQuality[] = [];
  protected animationFrameId?: number;
  protected canvas?: CanvasDecoder;

  protected constructor(
    videoSettings: VideoSettings,
    displayInfo?: DisplayInfo,
    name = "Canvas",
    storageKeyPrefix = "DummyCanvas",
    protected tag: HTMLCanvasElement = BaseCanvasBasedPlayer.createElement(),
    protected touchableCanvas: HTMLCanvasElement = document.createElement("canvas")
  ) {
    super(videoSettings, displayInfo, name, storageKeyPrefix, tag, touchableCanvas);
  }

  public static hasWebGLSupport(): boolean {
    // For some reason if I use here `this.tag` image on canvas will be flattened
    const testCanvas: HTMLCanvasElement = document.createElement("canvas");
    const validContextNames = ["webgl", "experimental-webgl", "moz-webgl", "webkit-3d"];
    let index = 0;

    let gl: any = null;
    while (!gl && index++ < validContextNames.length) {
      try {
        gl = testCanvas.getContext(validContextNames[index]);
      } catch (error: any) {
        gl = null;
        console.error(error);
      }
    }
    return !!gl;
  }

  public static createElement(id?: string): HTMLCanvasElement {
    const tag = document.createElement("canvas") as HTMLCanvasElement;
    if (typeof id === "string") {
      tag.id = id;
    }
    tag.className = "video-layer";
    return tag;
  }

  public getImageDataURL(): string {
    return this.tag.toDataURL();
  }

  public play(): void {
    super.play();
    if (this.getState() !== BasePlayer.STATE.PLAYING || !this.screenInfo) {
      return;
    }
    if (!this.canvas) {
      const { width, height } = this.screenInfo.videoSize;
      this.initCanvas(width, height);
      this.resetStats();
    }
    this.shiftFrame();
  }

  public stop(): void {
    super.stop();
    this.clearState();
  }

  public setScreenInfo(screenInfo: ScreenInfo): void {
    super.setScreenInfo(screenInfo);
    this.clearState();
    const { width, height } = screenInfo.videoSize;
    this.initCanvas(width, height);
    this.framesList = [];
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = undefined;
    }
  }

  public pushFrame(frame: Uint8Array): void {
    super.pushFrame(frame);
    if (BasePlayer.isIFrame(frame)) {
      if (this.videoSettings) {
        const { maxFps } = this.videoSettings;
        if (this.framesList.length > maxFps / 2) {
          const dropped = this.framesList.length;
          this.framesList = [];
          this.videoStats.push({
            decodedFrames: 0,
            droppedFrames: dropped,
            inputBytes: 0,
            inputFrames: 0,
            timestamp: Date.now(),
          });
        }
      }
    }
    this.framesList.push(frame);
    this.shiftFrame();
  }

  protected abstract decode(data: Uint8Array): void;

  protected drawDecoded = (): void => {
    if (!this.canvas) {
      return;
    }
    if (this.receivedFirstFrame) {
      const data = this.decodedFrames.shift();
      if (data) {
        const { frame, width, height } = data;
        this.canvas.decode(frame, width, height);
      }
    }
    if (this.decodedFrames.length) {
      this.animationFrameId = requestAnimationFrame(this.drawDecoded);
    } else {
      this.animationFrameId = undefined;
    }
  };

  protected onFrameDecoded(width: number, height: number, frame: any): void {
    if (!this.receivedFirstFrame) {
      // decoded frame with previous video settings
      return;
    }
    let dropped = 0;
    const maxStored = this.videoSettings.maxFps / 10; // for 100ms

    while (this.decodedFrames.length > maxStored) {
      const data = this.decodedFrames.shift();
      if (data) {
        this.dropFrame(data.frame);
        dropped++;
      }
    }
    this.decodedFrames.push({ width, height, frame });
    this.videoStats.push({
      decodedFrames: 1,
      droppedFrames: dropped,
      inputBytes: 0,
      inputFrames: 0,
      timestamp: Date.now(),
    });
    if (!this.animationFrameId) {
      this.animationFrameId = requestAnimationFrame(this.drawDecoded);
    }
  }

  protected dropFrame(_frame: any): void {
    // dispose frame if required
  }

  protected calculateMomentumStats(): void {
    const timestamp = Date.now();
    const oneSecondBefore = timestamp - 1000;

    while (this.videoStats.length && this.videoStats[0].timestamp < oneSecondBefore) {
      this.videoStats.shift();
    }
    while (this.inputBytes.length && this.inputBytes[0].timestamp < oneSecondBefore) {
      this.inputBytes.shift();
    }
    let decodedFrames = 0;
    let droppedFrames = 0;
    let inputBytes = 0;
    this.videoStats.forEach((item) => {
      decodedFrames += item.decodedFrames;
      droppedFrames += item.droppedFrames;
    });
    this.inputBytes.forEach((item) => {
      inputBytes += item.bytes;
    });
    this.momentumQualityStats = {
      decodedFrames,
      droppedFrames,
      inputFrames: this.inputBytes.length,
      inputBytes,
      timestamp,
    };
  }

  protected resetStats(): void {
    super.resetStats();
    this.videoStats = [];
  }

  protected initCanvas(width: number, height: number): void {
    if (this.canvas) {
      const parent = this.tag.parentNode;
      if (parent) {
        const tag = BaseCanvasBasedPlayer.createElement(this.tag.id);
        tag.className = this.tag.className;
        parent.replaceChild(tag, this.tag);
        parent.appendChild(this.touchableCanvas);
        this.tag = tag;
      }
    }
    this.tag.onerror = (event: Event | string): void => {
      console.error(`[${this.name}]`, event);
    };
    this.tag.oncontextmenu = (event: MouseEvent): void => {
      event.preventDefault();
    };
    this.tag.width = Math.round(width);
    this.tag.height = Math.round(height);
  }

  protected clearState(): void {
    this.framesList = [];
  }

  private shiftFrame(): void {
    if (this.getState() !== BasePlayer.STATE.PLAYING) {
      return;
    }
    const first = this.framesList.shift();
    if (first) {
      this.decode(first);
    }
  }
}

import { DataUtil, TypedEmitter, VideoSettings } from "./CommonUtil";
import { BasePlayer, PlayerClass } from "./player/BasePlayer";

import {
  ControlMessage,
  DeviceMessage,
  CommandControlMessage,
  KeyCodeControlMessage,
} from "./MessageCenter";
import {
  InteractionHandler,
  InteractionHandlerListener,
  KeyEventListener,
  KeyInputHandler,
} from "./InteractionHandler";

import { Size, DisplayInfo, ScreenInfo } from "./GeometryInfo";
import { KeyEvent } from "@/components/remote/KeySpaceMap.ts";
import { SecureWebSocket } from "@/shared/SecureWebSocket.ts";

type StartParams = {
  player: BasePlayer;
  videoSettings: VideoSettings;
};

const DEVICE_NAME_FIELD_LENGTH = 64;
const MAGIC_BYTES_INITIAL = DataUtil.stringToUtf8ByteArray("scrcpy_initial");

export type ClientsStats = {
  deviceName: string;
  clientId: number;
};

export type DisplayCombinedInfo = {
  displayInfo: DisplayInfo;
  videoSettings?: VideoSettings;
  screenInfo?: ScreenInfo;
  connectionCount: number;
};

interface StreamReceiverEvents {
  video: ArrayBuffer;
  deviceMessage: DeviceMessage;
  displayInfo: DisplayCombinedInfo[];
  clientsStats: ClientsStats;
  encoders: string[];
  connected: void;
  disconnected: CloseEvent;
}

export const BTN_FUNC_MAP = {
  "power": KeyEvent.KEYCODE_POWER,
  "vol_up": KeyEvent.KEYCODE_VOLUME_UP,
  "vol_dn": KeyEvent.KEYCODE_VOLUME_DOWN,
  "back": KeyEvent.KEYCODE_BACK,
  "home": KeyEvent.KEYCODE_HOME,
  "switch": KeyEvent.KEYCODE_APP_SWITCH,
};

interface EventMap {
  message: MessageEvent;
  close: CloseEvent;
  open: Event;
}
type Listener<K extends keyof EventMap> = EventMap[K] extends void
  ? () => void
  : (event: EventMap[K]) => void;

export class WSMiddleware {
  private sender: ((data: ArrayBuffer | Uint8Array) => void) | undefined;
  private listeners: {
    [K in keyof EventMap]?: Listener<K>[];
  } = {};

  constructor(private ws: SecureWebSocket) {}

  get readyState(): number {
    return this.ws.readyState ?? 0;
  }

  addEventListener<K extends keyof EventMap>(type: K, listener: Listener<K>) {
    this.listeners[type] ??= [];
    this.listeners[type]!.push(listener);
  }

  dispatchEvent<K extends keyof EventMap>(type: K, event: EventMap[K]) {
    this.listeners[type]?.forEach((listener) => {
      (listener as any)(event);
    });
  }

  public bindSender(sender: (data: ArrayBuffer | Uint8Array) => void): void {
    this.sender = sender;
  }

  public send(bytes: ArrayBuffer | Uint8Array): void {
    this.sender?.(bytes);
  }

  public close(): void {
    this.ws.close();
  }
}

export class StreamReceiver extends TypedEmitter<StreamReceiverEvents> {
  protected ws?: WSMiddleware;
  private events: ControlMessage[] = [];
  private encodersSet: Set<string> = new Set<string>();
  private clientId = -1;
  private deviceName = "";
  private readonly displayInfoMap: Map<number, DisplayInfo> = new Map();
  private readonly connectionCountMap: Map<number, number> = new Map();
  private readonly screenInfoMap: Map<number, ScreenInfo> = new Map();
  private readonly videoSettingsMap: Map<number, VideoSettings> = new Map();
  private hasInitialInfo = false;

  constructor(ws: WSMiddleware) {
    super();
    this.openNewConnection(ws);
  }

  private static EqualArrays(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0, l = a.length; i < l; i++) {
      if (a[i] !== b[i]) {
        return false;
      }
    }
    return true;
  }

  public sendEvent(event: ControlMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(event.toBuffer());
    } else {
      this.events.push(event);
    }
  }

  public getEncoders(): string[] {
    return Array.from(this.encodersSet.values());
  }

  public triggerInitialInfoEvents(): void {
    if (this.hasInitialInfo) {
      const encoders = this.getEncoders();
      this.emit("encoders", encoders);
      const { clientId, deviceName } = this;
      this.emit("clientsStats", { clientId, deviceName });
      const infoArray: DisplayCombinedInfo[] = [];
      this.displayInfoMap.forEach((displayInfo: DisplayInfo, displayId: number) => {
        const connectionCount = this.connectionCountMap.get(displayId) || 0;
        infoArray.push({
          displayInfo,
          videoSettings: this.videoSettingsMap.get(displayId),
          screenInfo: this.screenInfoMap.get(displayId),
          connectionCount,
        });
      });
      this.emit("displayInfo", infoArray);
    }
  }

  protected openNewConnection(ws: WSMiddleware): void {
    ws.addEventListener("open", this.onSocketOpen.bind(this));
    ws.addEventListener("message", this.onSocketMessage.bind(this));
    ws.addEventListener("close", this.onSocketClose.bind(this));
    this.ws = ws;
  }

  protected onSocketClose(ev: CloseEvent): void {
    console.log(`WS closed: ${ev.reason}`);
    this.emit("disconnected", ev);
  }

  protected onSocketMessage(event: MessageEvent): void {
    if (event.data instanceof ArrayBuffer) {
      // works only because MAGIC_BYTES_INITIAL and MAGIC_BYTES_MESSAGE have same length
      if (event.data.byteLength > MAGIC_BYTES_INITIAL.length) {
        const magicBytes = new Uint8Array(event.data, 0, MAGIC_BYTES_INITIAL.length);
        if (StreamReceiver.EqualArrays(magicBytes, MAGIC_BYTES_INITIAL)) {
          this.handleInitialInfo(event.data);
          return;
        }
        if (StreamReceiver.EqualArrays(magicBytes, DeviceMessage.MAGIC_BYTES_MESSAGE)) {
          const message = DeviceMessage.fromBuffer(event.data);
          this.emit("deviceMessage", message);
          return;
        }
      }

      this.emit("video", new Uint8Array(event.data));
    }
  }

  protected onSocketOpen(): void {
    this.emit("connected", void 0);
    let e = this.events.shift();
    while (e) {
      this.sendEvent(e);
      e = this.events.shift();
    }
  }

  private handleInitialInfo(data: ArrayBuffer): void {
    let offset = MAGIC_BYTES_INITIAL.length;
    let nameBytes = new Uint8Array(data, offset, DEVICE_NAME_FIELD_LENGTH);
    offset += DEVICE_NAME_FIELD_LENGTH;
    let rest: Buffer = Buffer.from(new Uint8Array(data, offset));
    const displaysCount = rest.readInt32BE(0);
    this.displayInfoMap.clear();
    this.connectionCountMap.clear();
    this.screenInfoMap.clear();
    this.videoSettingsMap.clear();
    rest = rest.subarray(4);
    for (let i = 0; i < displaysCount; i++) {
      const displayInfoBuffer = rest.subarray(0, DisplayInfo.BUFFER_LENGTH);
      const displayInfo = DisplayInfo.fromBuffer(displayInfoBuffer);
      const { displayId } = displayInfo;
      this.displayInfoMap.set(displayId, displayInfo);
      rest = rest.subarray(DisplayInfo.BUFFER_LENGTH);
      this.connectionCountMap.set(displayId, rest.readInt32BE(0));
      rest = rest.subarray(4);
      const screenInfoBytesCount = rest.readInt32BE(0);
      rest = rest.subarray(4);
      if (screenInfoBytesCount) {
        this.screenInfoMap.set(
          displayId,
          ScreenInfo.fromBuffer(rest.subarray(0, screenInfoBytesCount))
        );
        rest = rest.subarray(screenInfoBytesCount);
      }
      const videoSettingsBytesCount = rest.readInt32BE(0);
      rest = rest.subarray(4);
      if (videoSettingsBytesCount) {
        this.videoSettingsMap.set(
          displayId,
          VideoSettings.fromBuffer(rest.subarray(0, videoSettingsBytesCount))
        );
        rest = rest.subarray(videoSettingsBytesCount);
      }
    }
    this.encodersSet.clear();
    const encodersCount = rest.readInt32BE(0);
    rest = rest.subarray(4);
    for (let i = 0; i < encodersCount; i++) {
      const nameLength = rest.readInt32BE(0);
      rest = rest.subarray(4);
      const nameBytes = rest.subarray(0, nameLength);
      rest = rest.subarray(nameLength);
      const name = DataUtil.utf8ByteArrayToString(nameBytes);
      this.encodersSet.add(name);
    }
    this.clientId = rest.readInt32BE(0);
    nameBytes = DataUtil.filterTrailingZeroes(nameBytes);
    this.deviceName = DataUtil.utf8ByteArrayToString(nameBytes);
    this.hasInitialInfo = true;
    this.triggerInitialInfoEvents();
  }

  public closeWebSocket(): void {
    this.ws?.close();
  }
}

export class StreamClientScrcpy
  extends TypedEmitter<never>
  implements KeyEventListener, InteractionHandlerListener
{
  private static players: Map<string, PlayerClass> = new Map<string, PlayerClass>();

  private deviceName = "";
  private clientsCount = -1;
  private joinedStream = false;
  private touchHandler?: InteractionHandler;
  private player?: BasePlayer;
  private onClipBoxReceived?: (text: string) => void;
  private readonly streamReceiver: StreamReceiver;

  protected constructor(ws: WSMiddleware, player: BasePlayer, videoSettings: VideoSettings) {
    super();
    this.streamReceiver = new StreamReceiver(ws);
    this.startStream({ player, videoSettings });
  }

  public static registerPlayer(playerClass: PlayerClass): void {
    if (playerClass.isSupported()) {
      this.players.set(playerClass.playerFullName, playerClass);
    }
  }

  public static start(
    ws: WSMiddleware,
    player: BasePlayer,
    videoSettings: VideoSettings
  ): StreamClientScrcpy {
    return new StreamClientScrcpy(ws, player, videoSettings);
  }

  private static createVideoSettingsWithBounds(old: VideoSettings, newBounds: Size): VideoSettings {
    return new VideoSettings({
      crop: old.crop,
      bitrate: old.bitrate,
      bounds: newBounds,
      maxFps: old.maxFps,
      iFrameInterval: old.iFrameInterval,
      sendFrameMeta: old.sendFrameMeta,
      lockedVideoOrientation: old.lockedVideoOrientation,
      displayId: old.displayId,
      codecOptions: old.codecOptions,
      encoderName: old.encoderName,
    });
  }

  public setOnClipBoxReceived = (func: (text: string) => void): void => {
    this.onClipBoxReceived = func;
  };

  public OnDeviceMessage = (message: DeviceMessage): void => {
    if (this.onClipBoxReceived && message.type === DeviceMessage.TYPE_CLIPBOARD) {
      this.onClipBoxReceived(message.getText());
    }
  };

  public onVideo = (data: ArrayBuffer): void => {
    if (!this.player) {
      return;
    }
    const STATE = BasePlayer.STATE;
    if (this.player.getState() === STATE.PAUSED) {
      this.player.play();
    }
    if (this.player.getState() === STATE.PLAYING) {
      this.player.pushFrame(new Uint8Array(data));
    }
  };

  public onClientsStats = (stats: ClientsStats): void => {
    this.deviceName = stats.deviceName;
  };

  public onDisplayInfo = (infoArray: DisplayCombinedInfo[]): void => {
    if (!this.player) {
      return;
    }
    const currentSettings = this.player.getVideoSettings();
    const displayId = currentSettings.displayId;
    const info = infoArray.find((value) => {
      return value.displayInfo.displayId === displayId;
    });
    if (!info) {
      return;
    }
    if (this.player.getState() === BasePlayer.STATE.PAUSED) {
      this.player.play();
    }
    const { videoSettings, screenInfo } = info;
    this.player.setDisplayInfo(info.displayInfo);
    if (!videoSettings || !screenInfo) {
      this.joinedStream = true;
      this.sendMessage(CommandControlMessage.createSetVideoSettingsCommand(currentSettings));
      return;
    }

    this.clientsCount = info.connectionCount;
    let min = VideoSettings.copy(videoSettings);
    const oldInfo = this.player.getScreenInfo();
    if (!screenInfo.equals(oldInfo)) {
      this.player.setScreenInfo(screenInfo);
    }

    if (!videoSettings.equals(currentSettings)) {
      this.applyNewVideoSettings(videoSettings);
    }

    if (!oldInfo) {
      const bounds = currentSettings.bounds;
      const videoSize: Size = screenInfo.videoSize;
      const onlyOneClient = this.clientsCount === 0;
      const smallerThenCurrent =
        bounds && (bounds.width < videoSize.width || bounds.height < videoSize.height);
      if (onlyOneClient || smallerThenCurrent) {
        min = currentSettings;
      }
      const minBounds = currentSettings.bounds?.intersect(min.bounds);
      if (minBounds && !minBounds.equals(min.bounds)) {
        min = StreamClientScrcpy.createVideoSettingsWithBounds(min, minBounds);
      }
    }
    if (!min.equals(videoSettings) || !this.joinedStream) {
      this.joinedStream = true;
      this.sendMessage(CommandControlMessage.createSetVideoSettingsCommand(min));
    }
  };

  public onDisconnected = (): void => {
    this.streamReceiver.off("deviceMessage", this.OnDeviceMessage);
    this.streamReceiver.off("video", this.onVideo);
    this.streamReceiver.off("clientsStats", this.onClientsStats);
    this.streamReceiver.off("displayInfo", this.onDisplayInfo);
    this.streamReceiver.off("disconnected", this.onDisconnected);

    this.touchHandler?.release();
    this.touchHandler = undefined;
  };

  public startStream({ player, videoSettings }: StartParams): void {
    this.player = player;
    this.setTouchListeners(player);
    player.pause();
    this.applyNewVideoSettings(videoSettings);
    const streamReceiver = this.streamReceiver;
    streamReceiver.on("deviceMessage", this.OnDeviceMessage);
    streamReceiver.on("video", this.onVideo);
    streamReceiver.on("clientsStats", this.onClientsStats);
    streamReceiver.on("displayInfo", this.onDisplayInfo);
    streamReceiver.on("disconnected", this.onDisconnected);
    player.play();
  }

  public sendMessage(message: ControlMessage): void {
    this.streamReceiver.sendEvent(message);
  }

  public getDeviceName(): string {
    return this.deviceName;
  }

  public setHandleKeyboardEvents(enabled: boolean): void {
    if (enabled) {
      KeyInputHandler.addEventListener(this);
    } else {
      KeyInputHandler.removeEventListener(this);
    }
  }

  public setRequestedVideoSettings(value: VideoSettings): void {
    this.applyNewVideoSettings(value);
  }

  public onKeyEvent(event: KeyCodeControlMessage): void {
    this.sendMessage(event);
  }

  private setTouchListeners(player: BasePlayer): void {
    if (this.touchHandler) {
      return;
    }
    this.touchHandler = new InteractionHandler(player, this);
  }

  private applyNewVideoSettings(videoSettings: VideoSettings): void {
    if (this.player) {
      this.player.setVideoSettings(videoSettings);
    }
  }

  public disconnect(): void {
    this.streamReceiver.closeWebSocket();
  }
}

import { DataUtil, VideoSettings } from "./CommonUtil";
import { Buffer } from "buffer";
import { Position } from "./GeometryInfo";

export class ControlMessage {
  public static TYPE_KEYCODE = 0;
  public static TYPE_TEXT = 1;
  public static TYPE_TOUCH = 2;
  public static TYPE_SCROLL = 3;
  public static TYPE_EXPAND_NOTIFICATION_PANEL = 5;
  public static TYPE_EXPAND_SETTINGS_PANEL = 6;
  public static TYPE_COLLAPSE_PANELS = 7;
  public static TYPE_GET_CLIPBOARD = 8;
  public static TYPE_SET_CLIPBOARD = 9;
  public static TYPE_SET_SCREEN_POWER_MODE = 10;
  public static TYPE_ROTATE_DEVICE = 11;
  public static TYPE_CHANGE_STREAM_PARAMETERS = 101;

  constructor(readonly type: number) {}

  public toBuffer(): Buffer {
    throw Error("Not implemented");
  }

  public toString(): string {
    return "ControlMessage";
  }
}

export class DeviceMessage {
  public static TYPE_CLIPBOARD = 0;
  public static readonly MAGIC_BYTES_MESSAGE = DataUtil.stringToUtf8ByteArray("scrcpy_message");

  constructor(
    public readonly type: number,
    protected readonly buffer: Buffer
  ) {}

  public static fromBuffer(data: ArrayBuffer): DeviceMessage {
    const magicSize = this.MAGIC_BYTES_MESSAGE.length;
    const buffer = Buffer.from(data, magicSize, data.byteLength - magicSize);
    const type = buffer.readUInt8(0);
    return new DeviceMessage(type, buffer);
  }

  public getText(): string {
    if (this.type !== DeviceMessage.TYPE_CLIPBOARD) {
      throw TypeError(`Wrong message type: ${this.type}`);
    }
    if (!this.buffer) {
      throw Error("Empty buffer");
    }
    let offset = 1;
    const length = this.buffer.readInt32BE(offset);
    offset += 4;
    const textBytes = this.buffer.slice(offset, offset + length);
    return DataUtil.utf8ByteArrayToString(textBytes);
  }
  public toString(): string {
    let desc: string;
    if (this.type === DeviceMessage.TYPE_CLIPBOARD && this.buffer) {
      desc = `, text=[${this.getText()}]`;
    } else {
      desc = this.buffer ? `, buffer=[${this.buffer.join(",")}]` : "";
    }
    return `DeviceMessage{type=${this.type}${desc}}`;
  }
}

export class CommandControlMessage extends ControlMessage {
  public static PAYLOAD_LENGTH = 0;

  public static Commands: Map<number, string> = new Map([
    [ControlMessage.TYPE_EXPAND_NOTIFICATION_PANEL, "Expand notifications"],
    [ControlMessage.TYPE_EXPAND_SETTINGS_PANEL, "Expand settings"],
    [ControlMessage.TYPE_COLLAPSE_PANELS, "Collapse panels"],
    [ControlMessage.TYPE_GET_CLIPBOARD, "Get clipboard"],
    [ControlMessage.TYPE_SET_CLIPBOARD, "Set clipboard"],
    [ControlMessage.TYPE_ROTATE_DEVICE, "Rotate device"],
    [ControlMessage.TYPE_CHANGE_STREAM_PARAMETERS, "Change video settings"],
  ]);
  private buffer?: Buffer;

  constructor(readonly type: number) {
    super(type);
  }

  public static createSetVideoSettingsCommand(videoSettings: VideoSettings): CommandControlMessage {
    const temp = videoSettings.toBuffer();
    const event = new CommandControlMessage(ControlMessage.TYPE_CHANGE_STREAM_PARAMETERS);
    const offset = CommandControlMessage.PAYLOAD_LENGTH + 1;
    const buffer = Buffer.alloc(offset + temp.length);
    buffer.writeUInt8(event.type, 0);
    temp.forEach((byte, index) => {
      buffer.writeUInt8(byte, index + offset);
    });
    event.buffer = buffer;
    return event;
  }

  public static createSetClipboardCommand(text: string, paste = false): CommandControlMessage {
    const event = new CommandControlMessage(ControlMessage.TYPE_SET_CLIPBOARD);
    const textBytes: Uint8Array | null = text ? DataUtil.stringToUtf8ByteArray(text) : null;
    const textLength = textBytes ? textBytes.length : 0;
    let offset = 0;
    const buffer = Buffer.alloc(1 + 1 + 4 + textLength);
    offset = buffer.writeInt8(event.type, offset);
    offset = buffer.writeInt8(paste ? 1 : 0, offset);
    offset = buffer.writeInt32BE(textLength, offset);
    if (textBytes) {
      textBytes.forEach((byte: number, index: number) => {
        buffer.writeUInt8(byte, index + offset);
      });
    }
    event.buffer = buffer;
    return event;
  }

  public static createSetScreenPowerModeCommand(mode: boolean): CommandControlMessage {
    const event = new CommandControlMessage(ControlMessage.TYPE_SET_SCREEN_POWER_MODE);
    let offset = 0;
    const buffer = Buffer.alloc(1 + 1);
    offset = buffer.writeInt8(event.type, offset);
    buffer.writeUInt8(mode ? 1 : 0, offset);
    event.buffer = buffer;
    return event;
  }

  public toBuffer(): Buffer {
    if (!this.buffer) {
      const buffer = Buffer.alloc(CommandControlMessage.PAYLOAD_LENGTH + 1);
      buffer.writeUInt8(this.type, 0);
      this.buffer = buffer;
    }
    return this.buffer!;
  }

  public toString(): string {
    const buffer = this.buffer ? `, buffer=[${this.buffer.join(",")}]` : "";
    return `CommandControlMessage{action=${this.type}${buffer}}`;
  }
}

export class KeyCodeControlMessage extends ControlMessage {
  public static PAYLOAD_LENGTH = 13;

  constructor(
    readonly action: number,
    readonly keycode: number,
    readonly repeat: number,
    readonly metaState: number
  ) {
    super(ControlMessage.TYPE_KEYCODE);
  }

  public toBuffer(): Buffer {
    const buffer = Buffer.alloc(KeyCodeControlMessage.PAYLOAD_LENGTH + 1);
    let offset = 0;
    offset = buffer.writeInt8(this.type, offset);
    offset = buffer.writeInt8(this.action, offset);
    offset = buffer.writeInt32BE(this.keycode, offset);
    offset = buffer.writeInt32BE(this.repeat, offset);
    buffer.writeInt32BE(this.metaState, offset);
    return buffer;
  }

  public toString(): string {
    return `KeyCodeControlMessage{action=${this.action}, keycode=${this.keycode}, metaState=${this.metaState}}`;
  }
}

export class ScrollControlMessage extends ControlMessage {
  public static PAYLOAD_LENGTH = 20;

  constructor(
    readonly position: Position,
    readonly hScroll: number,
    readonly vScroll: number
  ) {
    super(ControlMessage.TYPE_SCROLL);
  }

  public toBuffer(): Buffer {
    const buffer = Buffer.alloc(ScrollControlMessage.PAYLOAD_LENGTH + 1);
    let offset = 0;
    offset = buffer.writeUInt8(this.type, offset);
    offset = buffer.writeUInt32BE(this.position.point.x, offset);
    offset = buffer.writeUInt32BE(this.position.point.y, offset);
    offset = buffer.writeUInt16BE(this.position.screenSize.width, offset);
    offset = buffer.writeUInt16BE(this.position.screenSize.height, offset);
    offset = buffer.writeInt32BE(this.hScroll, offset);
    buffer.writeInt32BE(this.vScroll, offset);
    return buffer;
  }

  public toString(): string {
    return `ScrollControlMessage{hScroll=${this.hScroll}, vScroll=${this.vScroll}, position=${this.position}}`;
  }
}

export class TextControlMessage extends ControlMessage {
  private static TEXT_SIZE_FIELD_LENGTH = 4;
  constructor(readonly text: string) {
    super(ControlMessage.TYPE_TEXT);
  }

  public toBuffer(): Buffer {
    const length = this.text.length;
    const buffer = Buffer.alloc(length + 1 + TextControlMessage.TEXT_SIZE_FIELD_LENGTH);
    let offset = 0;
    offset = buffer.writeUInt8(this.type, offset);
    offset = buffer.writeUInt32BE(length, offset);
    buffer.write(this.text, offset);
    return buffer;
  }

  public toString(): string {
    return `TextControlMessage{text=${this.text}}`;
  }
}

export class TouchControlMessage extends ControlMessage {
  public static PAYLOAD_LENGTH = 28;
  /**
   * - For a Touch Screen or Touch Pad, reports the approximate pressure
   * applied to the surface by a finger or other tool.  The value is
   * normalized to a range from 0 (no pressure at all) to 1 (normal pressure),
   * although values higher than 1 may be generated depending on the
   * calibration of the input device.
   * - For a trackball, the value is set to 1 if the trackball button is pressed
   * or 0 otherwise.
   * - For a mouse, the value is set to 1 if the primary mouse button is pressed
   * or 0 otherwise.
   *
   * - scrcpy server expects signed short (2 bytes) for a pressure value
   * - in browser TouchEvent has `force` property (values in 0..1 range), we
   * use it as "pressure" for scrcpy
   */
  public static readonly MAX_PRESSURE_VALUE = 0xffff;

  constructor(
    readonly action: number,
    readonly pointerId: number,
    readonly position: Position,
    readonly pressure: number,
    readonly buttons: number
  ) {
    super(ControlMessage.TYPE_TOUCH);
  }

  /**
   * @override
   */
  public toBuffer(): Buffer {
    const buffer: Buffer = Buffer.alloc(TouchControlMessage.PAYLOAD_LENGTH + 1);
    let offset = 0;
    offset = buffer.writeUInt8(this.type, offset);
    offset = buffer.writeUInt8(this.action, offset);
    offset = buffer.writeUInt32BE(0, offset); // pointerId is `long` (8 bytes) on java side
    offset = buffer.writeUInt32BE(this.pointerId, offset);
    offset = buffer.writeUInt32BE(this.position.point.x, offset);
    offset = buffer.writeUInt32BE(this.position.point.y, offset);
    offset = buffer.writeUInt16BE(this.position.screenSize.width, offset);
    offset = buffer.writeUInt16BE(this.position.screenSize.height, offset);
    offset = buffer.writeUInt16BE(this.pressure * TouchControlMessage.MAX_PRESSURE_VALUE, offset);
    buffer.writeUInt32BE(this.buttons, offset);
    return buffer;
  }

  public toString(): string {
    return `TouchControlMessage{action=${this.action}, pointerId=${this.pointerId}, position=${this.position}, pressure=${this.pressure}, buttons=${this.buttons}}`;
  }
}

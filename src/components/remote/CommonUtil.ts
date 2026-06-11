import { Rect, Size } from "./GeometryInfo";
import { EventEmitter } from "events";

interface Settings {
  crop?: Rect | null;
  bitrate: number;
  bounds?: Size | null;
  maxFps: number;
  iFrameInterval: number;
  sendFrameMeta?: boolean;
  lockedVideoOrientation?: number;
  displayId?: number;
  codecOptions?: string;
  encoderName?: string;
}

export class DataUtil {
  private static SUFFIX: Record<number, string> = {
    0: "B",
    1: "KiB",
    2: "MiB",
    3: "GiB",
    4: "TiB",
  };
  private static supportsPassiveValue: boolean | undefined;

  public static filterTrailingZeroes(bytes: Uint8Array): Uint8Array {
    let b = 0;
    return bytes
      .reverse()
      .filter((i) => b || (b = i))
      .reverse();
  }

  public static prettyBytes(value: number): string {
    let suffix = 0;
    while (value >= 512) {
      suffix++;
      value /= 1024;
    }
    return `${value.toFixed(suffix ? 1 : 0)}${DataUtil.SUFFIX[suffix]}`;
  }

  public static parseString(params: URLSearchParams, name: string, required?: boolean): string {
    const value = params.get(name);
    if (required && value === null) {
      throw TypeError(`Missing required parameter "${name}"`);
    }
    return value || "";
  }

  public static parseBooleanEnv(
    input: string | string[] | boolean | undefined | null
  ): boolean | undefined {
    if (typeof input === "boolean") {
      return input;
    }
    if (typeof input === "undefined" || input === null) {
      return undefined;
    }
    if (Array.isArray(input)) {
      input = input[input.length - 1];
    }
    return input === "1" || input.toLowerCase() === "true";
  }

  public static parseStringEnv(input: string | string[] | undefined | null): string | undefined {
    if (typeof input === "undefined" || input === null) {
      return undefined;
    }
    if (Array.isArray(input)) {
      input = input[input.length - 1];
    }
    return input;
  }
  public static parseIntEnv(
    input: string | string[] | number | undefined | null
  ): number | undefined {
    if (typeof input === "number") {
      return input;
    }
    if (typeof input === "undefined" || input === null) {
      return undefined;
    }
    if (Array.isArray(input)) {
      input = input[input.length - 1];
    }
    const int = parseInt(input, 10);
    if (isNaN(int)) {
      return undefined;
    }
    return int;
  }

  // https://github.com/google/closure-library/blob/51e5a5ac373aefa354a991816ec418d730e29a7e/closure/goog/crypt/crypt.js#L117
  /*
        Copyright 2008 The Closure Library Authors. All Rights Reserved.
        Licensed under the Apache License, Version 2.0 (the "License");
        you may not use this file except in compliance with the License.
        You may obtain a copy of the License at

             http://www.apache.org/licenses/LICENSE-2.0

        Unless required by applicable law or agreed to in writing, software
        distributed under the License is distributed on an "AS-IS" BASIS,
        WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
        See the License for the specific language governing permissions and
        limitations under the License.
     */
  /* tslint:disable */
  /**
   * Converts a JS string to a UTF-8 "byte" array.
   * @param {string} str 16-bit Unicode string.
   * @return {Uint8Array} UTF-8 byte array.
   */
  static stringToUtf8ByteArray = function (str: string): Uint8Array {
    const out = [];
    let p = 0;
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (c < 128) {
        out[p++] = c;
      } else if (c < 2048) {
        out[p++] = (c >> 6) | 192;
        out[p++] = (c & 63) | 128;
      } else if (
        (c & 0xfc00) == 0xd800 &&
        i + 1 < str.length &&
        (str.charCodeAt(i + 1) & 0xfc00) == 0xdc00
      ) {
        // Surrogate Pair
        c = 0x10000 + ((c & 0x03ff) << 10) + (str.charCodeAt(++i) & 0x03ff);
        out[p++] = (c >> 18) | 240;
        out[p++] = ((c >> 12) & 63) | 128;
        out[p++] = ((c >> 6) & 63) | 128;
        out[p++] = (c & 63) | 128;
      } else {
        out[p++] = (c >> 12) | 224;
        out[p++] = ((c >> 6) & 63) | 128;
        out[p++] = (c & 63) | 128;
      }
    }
    return Uint8Array.from(out);
  };

  /**
   * Converts a UTF-8 byte array to JavaScript's 16-bit Unicode.
   * @param {Uint8Array|Array<number>} bytes UTF-8 byte array.
   * @return {string} 16-bit Unicode string.
   */
  static utf8ByteArrayToString(bytes: Uint8Array): string {
    // TODO(user): Use native implementations if/when available
    const out = [];
    let pos = 0,
      c = 0;
    while (pos < bytes.length) {
      const c1 = bytes[pos++];
      if (c1 < 128) {
        out[c++] = String.fromCharCode(c1);
      } else if (c1 > 191 && c1 < 224) {
        const c2 = bytes[pos++];
        out[c++] = String.fromCharCode(((c1 & 31) << 6) | (c2 & 63));
      } else if (c1 > 239 && c1 < 365) {
        // Surrogate Pair
        const c2 = bytes[pos++];
        const c3 = bytes[pos++];
        const c4 = bytes[pos++];
        const u = (((c1 & 7) << 18) | ((c2 & 63) << 12) | ((c3 & 63) << 6) | (c4 & 63)) - 0x10000;
        out[c++] = String.fromCharCode(0xd800 + (u >> 10));
        out[c++] = String.fromCharCode(0xdc00 + (u & 1023));
      } else {
        const c2 = bytes[pos++];
        const c3 = bytes[pos++];
        out[c++] = String.fromCharCode(((c1 & 15) << 12) | ((c2 & 63) << 6) | (c3 & 63));
      }
    }
    return out.join("");
  }
  /* tslint:enable */

  // https://github.com/WICG/EventListenerOptions/blob/gh-pages/explainer.md
  static supportsPassive(): boolean {
    if (typeof DataUtil.supportsPassiveValue === "boolean") {
      return DataUtil.supportsPassiveValue;
    }

    // Test via a getter in the options object to see if the passive property is accessed
    let supportsPassive = false;
    try {
      const opts = Object.defineProperty({}, "passive", {
        get: function () {
          supportsPassive = true;
        },
      });

      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-expect-error
      window.addEventListener("testPassive", null, opts);
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-expect-error
      window.removeEventListener("testPassive", null, opts);
    } catch (error: any) {
      console.error(error);
    }

    return (DataUtil.supportsPassiveValue = supportsPassive);
  }
}

export class VideoSettings {
  public static readonly BASE_BUFFER_LENGTH: number = 35;
  public readonly crop?: Rect | null = null;
  public readonly bitrate: number = 0;
  public readonly bounds?: Size | null = null;
  public readonly maxFps: number = 0;
  public readonly iFrameInterval: number = 0;
  public readonly sendFrameMeta: boolean = false;
  public readonly lockedVideoOrientation: number = -1;
  public readonly displayId: number = 0;
  public readonly codecOptions?: string;
  public readonly encoderName?: string;

  constructor(
    data?: Settings,
    public readonly bytesLength: number = VideoSettings.BASE_BUFFER_LENGTH
  ) {
    if (data) {
      this.crop = data.crop;
      this.bitrate = data.bitrate;
      this.bounds = data.bounds;
      this.maxFps = data.maxFps;
      this.iFrameInterval = data.iFrameInterval;
      this.sendFrameMeta = data.sendFrameMeta || false;
      this.lockedVideoOrientation = data.lockedVideoOrientation || -1;
      if (typeof data.displayId === "number" && !isNaN(data.displayId) && data.displayId >= 0) {
        this.displayId = data.displayId;
      }
      if (data.codecOptions) {
        this.codecOptions = data.codecOptions.trim();
      }
      if (data.encoderName) {
        this.encoderName = data.encoderName.trim();
      }
    }
  }

  public static fromBuffer(buffer: Buffer): VideoSettings {
    let offset = 0;
    const bitrate = buffer.readInt32BE(offset);
    offset += 4;
    const maxFps = buffer.readInt32BE(offset);
    offset += 4;
    const iFrameInterval = buffer.readInt8(offset);
    offset += 1;
    const width = buffer.readInt16BE(offset);
    offset += 2;
    const height = buffer.readInt16BE(offset);
    offset += 2;
    const left = buffer.readInt16BE(offset);
    offset += 2;
    const top = buffer.readInt16BE(offset);
    offset += 2;
    const right = buffer.readInt16BE(offset);
    offset += 2;
    const bottom = buffer.readInt16BE(offset);
    offset += 2;
    const sendFrameMeta = !!buffer.readInt8(offset);
    offset += 1;
    const lockedVideoOrientation = buffer.readInt8(offset);
    offset += 1;
    const displayId = buffer.readInt32BE(offset);
    offset += 4;
    let bounds: Size | null = null;
    let crop: Rect | null = null;
    if (width !== 0 && height !== 0) {
      bounds = new Size(width, height);
    }
    if (left || top || right || bottom) {
      crop = new Rect(left, top, right, bottom);
    }
    let codecOptions;
    let encoderName;
    const codecOptionsLength = buffer.readInt32BE(offset);
    offset += 4;
    if (codecOptionsLength) {
      const codecOptionsBytes = buffer.subarray(offset, offset + codecOptionsLength);
      offset += codecOptionsLength;
      codecOptions = DataUtil.utf8ByteArrayToString(codecOptionsBytes);
    }
    const encoderNameLength = buffer.readInt32BE(offset);
    offset += 4;
    if (encoderNameLength) {
      const encoderNameBytes = buffer.subarray(offset, offset + encoderNameLength);
      offset += encoderNameLength;
      encoderName = DataUtil.utf8ByteArrayToString(encoderNameBytes);
    }
    return new VideoSettings(
      {
        crop,
        bitrate,
        bounds,
        maxFps,
        iFrameInterval,
        lockedVideoOrientation,
        displayId,
        sendFrameMeta,
        codecOptions,
        encoderName,
      },
      offset
    );
  }

  public static copy(a: VideoSettings): VideoSettings {
    return new VideoSettings(
      {
        bitrate: a.bitrate,
        crop: Rect.copy(a.crop),
        bounds: Size.copy(a.bounds),
        maxFps: a.maxFps,
        iFrameInterval: a.iFrameInterval,
        lockedVideoOrientation: a.lockedVideoOrientation,
        displayId: a.displayId,
        sendFrameMeta: a.sendFrameMeta,
        codecOptions: a.codecOptions,
        encoderName: a.encoderName,
      },
      a.bytesLength
    );
  }

  public equals(o?: VideoSettings | null): boolean {
    if (!o) {
      return false;
    }
    return (
      this.encoderName === o.encoderName &&
      this.codecOptions === o.codecOptions &&
      Rect.equals(this.crop, o.crop) &&
      this.lockedVideoOrientation === o.lockedVideoOrientation &&
      this.displayId === o.displayId &&
      Size.equals(this.bounds, o.bounds) &&
      this.bitrate === o.bitrate &&
      this.maxFps === o.maxFps &&
      this.iFrameInterval === o.iFrameInterval
    );
  }

  public toBuffer(): Buffer {
    let additionalLength = 0;
    let codecOptionsBytes;
    let encoderNameBytes;
    if (this.codecOptions) {
      codecOptionsBytes = DataUtil.stringToUtf8ByteArray(this.codecOptions);
      additionalLength += codecOptionsBytes.length;
    }
    if (this.encoderName) {
      encoderNameBytes = DataUtil.stringToUtf8ByteArray(this.encoderName);
      additionalLength += encoderNameBytes.length;
    }
    const buffer = Buffer.alloc(VideoSettings.BASE_BUFFER_LENGTH + additionalLength);
    const { width = 0, height = 0 } = this.bounds || {};
    const { left = 0, top = 0, right = 0, bottom = 0 } = this.crop || {};
    let offset = 0;
    offset = buffer.writeInt32BE(this.bitrate, offset);
    offset = buffer.writeInt32BE(this.maxFps, offset);
    offset = buffer.writeInt8(this.iFrameInterval, offset);
    offset = buffer.writeInt16BE(width, offset);
    offset = buffer.writeInt16BE(height, offset);
    offset = buffer.writeInt16BE(left, offset);
    offset = buffer.writeInt16BE(top, offset);
    offset = buffer.writeInt16BE(right, offset);
    offset = buffer.writeInt16BE(bottom, offset);
    offset = buffer.writeInt8(this.sendFrameMeta ? 1 : 0, offset);
    offset = buffer.writeInt8(this.lockedVideoOrientation, offset);
    offset = buffer.writeInt32BE(this.displayId, offset);
    if (codecOptionsBytes) {
      offset = buffer.writeInt32BE(codecOptionsBytes.length, offset);
      buffer.fill(codecOptionsBytes, offset);
      offset += codecOptionsBytes.length;
    } else {
      offset = buffer.writeInt32BE(0, offset);
    }
    if (encoderNameBytes) {
      offset = buffer.writeInt32BE(encoderNameBytes.length, offset);
      buffer.fill(encoderNameBytes, offset);
    } else {
      buffer.writeInt32BE(0, offset);
    }
    return buffer;
  }

  public toString(): string {
    // prettier-ignore
    return `VideoSettings{bitrate=${
            this.bitrate}, maxFps=${
            this.maxFps}, iFrameInterval=${
            this.iFrameInterval}, bounds=${
            this.bounds}, crop=${
            this.crop}, metaFrame=${
            this.sendFrameMeta}, lockedVideoOrientation=${
            this.lockedVideoOrientation}, displayId=${
            this.displayId}, codecOptions=${
            this.codecOptions}, encoderName=${
            this.encoderName}}`;
  }
}

export type EventMap = Record<string, any>;
export type EventKey<T extends EventMap> = string & keyof T;
export type EventReceiver<T> = (params: T) => void;

export interface Emitter<T extends EventMap> {
  on<K extends EventKey<T>>(eventName: K, fn: EventReceiver<T[K]>): void;
  off<K extends EventKey<T>>(eventName: K, fn: EventReceiver<T[K]>): void;
  emit<K extends EventKey<T>>(eventName: K, params: T[K]): void;
}

export class TypedEmitter<T extends EventMap> implements Emitter<T> {
  private emitter = new EventEmitter();

  on<K extends EventKey<T>>(eventName: K, fn: EventReceiver<T[K]>): void {
    this.emitter.on(eventName, fn);
  }

  off<K extends EventKey<T>>(eventName: K, fn: EventReceiver<T[K]>): void {
    this.emitter.off(eventName, fn);
  }

  emit<K extends EventKey<T>>(eventName: K, params: T[K]): boolean {
    return this.emitter.emit(eventName, params);
  }
}

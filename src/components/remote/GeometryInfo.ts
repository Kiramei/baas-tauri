export class Point {
  readonly x: number;
  readonly y: number;
  /** Handles the constructor workflow. */
  constructor(x: number, y: number) {
    this.x = Math.round(x);
    this.y = Math.round(y);
  }
  /** Handles the to string workflow. */
  public toString(): string {
    return `Point{x=${this.x}, y=${this.y}}`;
  }
}

export class Size {
  public readonly w: number;
  public readonly h: number;

  /** Handles the constructor workflow. */
  constructor(
    readonly width: number,
    readonly height: number
  ) {
    this.w = width;
    this.h = height;
  }

  /** Handles the equals workflow. */
  public static equals(a?: Size | null, b?: Size | null): boolean {
    if (!a && !b) {
      return true;
    }
    return !!a && !!b && a.equals(b);
  }

  /** Handles the copy workflow. */
  public static copy(a?: Size | null): Size | null {
    if (!a) {
      return null;
    }
    return new Size(a.width, a.height);
  }

  /** Handles the length workflow. */
  length(): number {
    return this.w * this.h;
  }

  /** Handles the equals workflow. */
  public equals(o: Size | null | undefined): boolean {
    if (this === o) {
      return true;
    }
    if (!o) {
      return false;
    }
    return this.width === o.width && this.height === o.height;
  }

  /** Handles the intersect workflow. */
  public intersect(o: Size | undefined | null): Size {
    if (!o) {
      return this;
    }
    const minH = Math.min(this.height, o.height);
    const minW = Math.min(this.width, o.width);
    return new Size(minW, minH);
  }

  // noinspection JSUnusedGlobalSymbols
  public getHalfSize(): Size {
    return new Size(this.width >>> 1, this.height >>> 1);
  }

  /** Handles the to string workflow. */
  public toString(): string {
    return `Size{width=${this.width}, height=${this.height}}`;
  }
}

export class Position {
  /** Handles the constructor workflow. */
  public constructor(
    readonly point: Point,
    readonly screenSize: Size
  ) {}

  /** Handles the to string workflow. */
  public toString(): string {
    return `Position{point=${this.point}, screenSize=${this.screenSize}}`;
  }
}

export class Rect {
  /** Handles the constructor workflow. */
  constructor(
    readonly left: number,
    readonly top: number,
    readonly right: number,
    readonly bottom: number
  ) {
    this.left = left;
    this.top = top;
    this.right = right;
    this.bottom = bottom;
  }
  /** Handles the equals workflow. */
  public static equals(a?: Rect | null, b?: Rect | null): boolean {
    if (!a && !b) {
      return true;
    }
    return !!a && !!b && a.equals(b);
  }
  /** Handles the copy workflow. */
  public static copy(a?: Rect | null): Rect | null {
    if (!a) {
      return null;
    }
    return new Rect(a.left, a.top, a.right, a.bottom);
  }
  /** Handles the equals workflow. */
  public equals(o: Rect | null): boolean {
    if (this === o) {
      return true;
    }
    if (!o) {
      return false;
    }
    return (
      this.left === o.left &&
      this.top === o.top &&
      this.right === o.right &&
      this.bottom === o.bottom
    );
  }

  /** Handles the to string workflow. */
  public toString(): string {
    // prettier-ignore
    return `Rect{left=${
            this.left}, top=${
            this.top}, right=${
            this.right}, bottom=${
            this.bottom}}`;
  }
}

export class ScreenInfo {
  /** Handles the constructor workflow. */
  constructor(
    readonly contentRect: Rect,
    readonly videoSize: Size,
    readonly deviceRotation: number
  ) {}

  /** Handles the from buffer workflow. */
  public static fromBuffer(buffer: Buffer): ScreenInfo {
    const left = buffer.readInt32BE(0);
    const top = buffer.readInt32BE(4);
    const right = buffer.readInt32BE(8);
    const bottom = buffer.readInt32BE(12);
    const width = buffer.readInt32BE(16);
    const height = buffer.readInt32BE(20);
    const deviceRotation = buffer.readUInt8(24);
    return new ScreenInfo(
      new Rect(left, top, right, bottom),
      new Size(width, height),
      deviceRotation
    );
  }

  /** Handles the equals workflow. */
  public equals(o?: ScreenInfo | null): boolean {
    if (!o) {
      return false;
    }
    return (
      this.contentRect.equals(o.contentRect) &&
      this.videoSize.equals(o.videoSize) &&
      this.deviceRotation === o.deviceRotation
    );
  }

  /** Handles the to string workflow. */
  public toString(): string {
    return `ScreenInfo{contentRect=${this.contentRect}, videoSize=${this.videoSize}, deviceRotation=${this.deviceRotation}}`;
  }
}

export class DisplayInfo {
  public static readonly DEFAULT_DISPLAY = 0x00000000;
  public static readonly BUFFER_LENGTH = 24;

  /** Handles the constructor workflow. */
  constructor(
    public readonly displayId: number,
    public readonly size: Size,
    public readonly rotation: number,
    public readonly layerStack: number,
    public readonly flags: number
  ) {}

  /** Handles the from buffer workflow. */
  public static fromBuffer(buffer: Buffer): DisplayInfo {
    if (buffer.length !== DisplayInfo.BUFFER_LENGTH) {
      throw Error(
        `Incorrect buffer length. Expected: ${DisplayInfo.BUFFER_LENGTH}, received: ${buffer.length}`
      );
    }
    let offset = 0;
    const displayId = buffer.readInt32BE(offset);
    offset += 4;
    const width = buffer.readInt32BE(offset);
    offset += 4;
    const height = buffer.readInt32BE(offset);
    offset += 4;
    const rotation = buffer.readInt32BE(offset);
    offset += 4;
    const layerStack = buffer.readInt32BE(offset);
    offset += 4;
    const flags = buffer.readInt32BE(offset);
    return new DisplayInfo(displayId, new Size(width, height), rotation, layerStack, flags);
  }

  /** Handles the to string workflow. */
  public toString(): string {
    // prettier-ignore
    return `DisplayInfo{displayId=${
            this.displayId}, size=${
            this.size}, rotation=${
            this.rotation}, layerStack=${
            this.layerStack}, flags=${
            this.flags}}`;
  }
}

import { createConnection, type Socket } from "node:net";

export type ChannelName = "sync" | "provider" | "trigger";
export type Message = Record<string, any>;
export const PIPE_MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
const HEADER_SIZE = 10;

export interface ClientConnection {
  sendJson(payload: Message): void | Promise<void>;
  close(): void | Promise<void>;
}

/** The service's BPIP protocol is shared by Unix sockets and Windows named pipes. */
export function encodePipeFrame(kind: number, payload: Uint8Array): Buffer {
  if (payload.byteLength > PIPE_MAX_PAYLOAD_BYTES) throw new Error("Pipe payload exceeds 64 MiB");
  if (kind < 1 || kind > 4) throw new Error("Invalid pipe frame kind");
  const frame = Buffer.allocUnsafe(HEADER_SIZE + payload.byteLength);
  frame.write("BPIP", 0, "ascii");
  frame[4] = 1;
  frame[5] = kind;
  frame.writeUInt32LE(payload.byteLength, 6);
  frame.set(payload, HEADER_SIZE);
  return frame;
}

export class PipeFrameDecoder {
  private buffer = Buffer.alloc(0);

  feed(chunk: Uint8Array): { kind: number; payload: Buffer }[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: { kind: number; payload: Buffer }[] = [];
    let offset = 0;
    while (this.buffer.length - offset >= HEADER_SIZE) {
      if (
        this.buffer.toString("ascii", offset, offset + 4) !== "BPIP" ||
        this.buffer[offset + 4] !== 1
      )
        throw new Error("Invalid BPIP frame header");
      const kind = this.buffer[offset + 5];
      if (kind < 1 || kind > 4) throw new Error("Invalid pipe frame kind");
      const length = this.buffer.readUInt32LE(offset + 6);
      if (length > PIPE_MAX_PAYLOAD_BYTES) throw new Error("Pipe payload exceeds 64 MiB");
      const end = offset + HEADER_SIZE + length;
      if (this.buffer.length < end) break;
      frames.push({ kind, payload: this.buffer.subarray(offset + HEADER_SIZE, end) });
      offset = end;
    }
    this.buffer = this.buffer.subarray(offset);
    return frames;
  }
}

export class PipeConnection implements ClientConnection {
  private socket: Socket | null = null;
  private ready = false;
  private closing = false;
  private rejectOpening: ((error: Error) => void) | null = null;

  constructor(
    private readonly path: string,
    private readonly channel: ChannelName,
    private readonly timeoutMs: number,
    private readonly onMessage: (message: Message) => void,
    private readonly onDisconnect: (error: Error) => void
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const decoder = new PipeFrameDecoder();
      const socket = createConnection(this.path);
      this.socket = socket;
      let settled = false;
      let failed = false;
      const fail = (error: Error) => {
        if (failed) return;
        failed = true;
        this.rejectOpening = null;
        clearTimeout(timer);
        this.ready = false;
        if (!settled) {
          settled = true;
          reject(error);
        }
        if (!this.closing) this.onDisconnect(error);
        socket.destroy();
      };
      this.rejectOpening = fail;
      const timer = setTimeout(
        () => fail(new Error(`Timed out opening ${this.channel} pipe`)),
        this.timeoutMs
      );
      socket.on("connect", () => {
        socket.write(
          encodePipeFrame(1, Buffer.from(JSON.stringify({ type: "open", channel: this.channel })))
        );
      });
      socket.on("data", (data) => {
        try {
          for (const frame of decoder.feed(data)) {
            if (frame.kind === 4) throw new Error(frame.payload.toString("utf8"));
            if (frame.kind === 3) throw new Error(`${this.channel} pipe closed by backend`);
            if (frame.kind !== 1) throw new Error("Unexpected binary frame on JSON client channel");
            const message: Message = JSON.parse(frame.payload.toString("utf8"));
            if (!this.ready) {
              if (message.type !== "open_ok" || message.channel !== this.channel)
                throw new Error("Expected a matching pipe open acknowledgement");
              this.ready = true;
              settled = true;
              this.rejectOpening = null;
              clearTimeout(timer);
              resolve();
            } else this.onMessage(message);
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.on("error", fail);
      socket.on("close", () => {
        clearTimeout(timer);
        if (!this.closing) fail(new Error(`${this.channel} pipe disconnected`));
      });
    });
  }

  sendJson(payload: Message): void {
    if (!this.socket || !this.ready || this.socket.destroyed)
      throw new Error("Backend pipe is unavailable");
    this.socket.write(encodePipeFrame(1, Buffer.from(JSON.stringify(payload))));
  }

  close(): void {
    this.closing = true;
    this.rejectOpening?.(new Error("Backend pipe closed during connection"));
    this.rejectOpening = null;
    this.ready = false;
    this.socket?.destroy();
    this.socket = null;
  }
}

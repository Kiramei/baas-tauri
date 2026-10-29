import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

export interface MouseEvent {
  x: number;
  y: number;
  button: number;
  kind: "press" | "release" | "wheel";
  delta: number;
}
export class MouseBus extends EventEmitter {
  dispatch(event: MouseEvent) {
    this.emit("mouse", event);
  }
}

/** XTerm SGR 1006 reports, including reports split across stream chunks. */
export class MouseDecoder {
  private pending = "";
  constructor(private readonly mouse: (event: MouseEvent) => void) {}
  feed(chunk: string): string {
    // A new control key/escape sequence abandons a truncated report; never swallow Ctrl+C.
    if (this.pending.startsWith("\x1b[<")) {
      const boundary = Array.from(chunk).findIndex(
        (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
      );
      if (boundary >= 0 && !/^[\d;]*[Mm]/.test(chunk.slice(0, boundary))) {
        this.pending = "";
        chunk = chunk.slice(boundary);
      }
    }
    let text = this.pending + chunk,
      output = "";
    this.pending = "";
    while (text) {
      const index = text.indexOf("\x1b[<");
      if (index < 0) {
        const suffix = text.endsWith("\x1b[") ? 2 : text.endsWith("\x1b") ? 1 : 0;
        if (suffix) {
          this.pending = text.slice(-suffix);
          output += text.slice(0, -suffix);
        } else output += text;
        break;
      }
      output += text.slice(0, index);
      text = text.slice(index);
      // eslint-disable-next-line no-control-regex -- Decode trusted terminal protocol, never display it.
      const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(text);
      if (match) {
        const code = Number(match[1]),
          x = Number(match[2]) - 1,
          y = Number(match[3]) - 1;
        if (x >= 0 && y >= 0 && x < 10000 && y < 10000)
          this.mouse({
            x,
            y,
            button: code & 3,
            kind: code & 64 ? "wheel" : match[4] === "m" ? "release" : "press",
            delta: code & 64 ? (code & 1 ? 3 : -3) : 0,
          });
        text = text.slice(match[0].length);
      } else if (text.length < 64 && text.startsWith("\x1b[<") && /^[\d;]*$/.test(text.slice(3))) {
        this.pending = text;
        break;
      } else {
        // Malformed mouse packets are dropped, not pasted into a command.
        const end = text.search(/[Mm]/);
        text = end >= 0 ? text.slice(end + 1) : "";
      }
    }
    return output;
  }
  flush(): string {
    if (this.pending.startsWith("\x1b[<")) return "";
    const value = this.pending;
    this.pending = "";
    return value;
  }
}

/** Own the alternate screen and mouse modes for exactly one mounted workspace. */
export function terminalSession(
  source: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
  mouse: MouseBus
) {
  const input = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode(mode: boolean): void;
    ref(): void;
    unref(): void;
  };
  input.isTTY = !!source.isTTY;
  input.setRawMode = (mode) => source.setRawMode?.(mode);
  input.ref = () => {
    source.ref?.();
  };
  input.unref = () => {
    source.unref?.();
  };
  const wasPaused = source.isPaused();
  const wasRaw = source.isRaw;
  // Enable raw input before the first frame; early Enter must stay CR, not canonical LF.
  if (source.isTTY) source.setRawMode(true);
  const decoder = new MouseDecoder((event) => mouse.dispatch(event));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const feed = (chunk: Buffer | string) => {
    clearTimeout(timer);
    const result = decoder.feed(String(chunk));
    if (result) input.write(result);
    // A lone Esc remains an ordinary key; incomplete mouse reports stay bounded to 64 bytes.
    timer = setTimeout(() => {
      const rest = decoder.flush();
      if (rest === "\x1b" || rest === "\x1b[") input.write(rest);
    }, 25);
  };
  source.setEncoding("utf8");
  source.on("data", feed);
  const interactive = !!stdout.isTTY && !!source.isTTY && process.env.TERM !== "dumb";
  if (interactive) stdout.write("\x1b[?1049h\x1b[H\x1b[?1000h\x1b[?1006h");
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    source.removeListener("data", feed);
    input.destroy();
    if (source.isTTY) source.setRawMode(!!wasRaw);
    if (wasPaused) source.pause();
    if (interactive) stdout.write("\x1b[?1006l\x1b[?1000l\x1b[0m\x1b[?25h\x1b[?1049l");
  };
  return { input: input as unknown as NodeJS.ReadStream, close };
}

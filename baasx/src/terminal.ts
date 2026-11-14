import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { setAnimationFocused } from "./motion";
import { displayWidth } from "./ui";

const viewports = new WeakMap<NodeJS.WriteStream, NodeJS.WriteStream>();

/** Ink's output guard gets a spare row; layout and mouse coordinates use the real viewport. */
export function terminalViewport(stdout: NodeJS.WriteStream): NodeJS.WriteStream {
  return viewports.get(stdout) ?? stdout;
}

function fullscreenOutput(stdout: NodeJS.WriteStream) {
  const size = () => ({ columns: stdout.columns || 80, rows: stdout.rows || 30 });
  let highestRows = size().rows,
    resized = false,
    closed = false;
  // Ink 6 log-update prefixes subsequent frames with eraseLines(), followed by one LF.
  // A clear-only write is a separate operation, notably before ordinary console output.
  // eslint-disable-next-line no-control-regex -- Recognize Ink's exact redraw protocol.
  const erasePrefix = /^(?:\x1b\[2K(?:\x1b\[1A)?)+\x1b\[G/;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (closed) {
        done();
        return;
      }
      let text = String(chunk);
      const viewport = size();
      const prefix = erasePrefix.exec(text)?.[0] ?? "";
      const payload = prefix ? text.slice(prefix.length) : text;
      const lines = payload.endsWith("\n") ? payload.slice(0, -1).split("\n") : [];
      // The first frame (also the first after log.clear()) has no erase prefix.
      // Short, unprefixed console writes retain their exact content and newline.
      const frame = lines.length > 0 && (!!prefix || lines.length === viewport.rows);
      if (frame) {
        // Ink's resize callback can render the old explicitly sized React tree first.
        // Wait for useSize's new layout instead of wrapping/scrolling that stale frame.
        if (
          lines.length !== viewport.rows ||
          (resized && lines.some((line) => displayWidth(line) > viewport.columns))
        ) {
          done();
          return;
        }
        resized = false;
        // Address every line from a known origin, without the LF that would scroll
        // at the bottom edge. EL2 removes old suffixes even after console writes.
        text = `\x1b[H${lines.map((line) => `\x1b[2K${line}`).join("\n")}`;
      }
      stdout.write(text, done);
    },
  });
  Object.defineProperties(output, {
    isTTY: { value: true },
    columns: { get: () => size().columns },
    // A high-water mark also protects Ink's previous frame during a resize shrink.
    rows: { get: () => (highestRows = Math.max(highestRows, size().rows)) + 1 },
  });
  const resize = () => {
    highestRows = Math.max(highestRows, size().rows);
    resized = true;
    output.emit("resize");
  };
  stdout.on("resize", resize);
  const stream = output as unknown as NodeJS.WriteStream;
  viewports.set(stream, stdout);
  return {
    stream,
    close() {
      closed = true;
      stdout.off("resize", resize);
    },
  };
}

export interface MouseEvent {
  x: number;
  y: number;
  button: number;
  kind: "press" | "release" | "wheel" | "drag";
  delta: number;
}
export class MouseBus extends EventEmitter {
  private captured?: { handle: (event: MouseEvent) => void; cancel: () => void };

  get hasCapture() {
    return !!this.captured;
  }

  /** Keep a drag bound to its handle when it crosses other controls or the viewport. */
  capture(handle: (event: MouseEvent) => void, cancel: () => void) {
    this.cancelCapture();
    const captured = { handle, cancel };
    this.captured = captured;
    return () => {
      if (this.captured === captured) this.captured = undefined;
    };
  }

  cancelCapture() {
    const captured = this.captured;
    this.captured = undefined;
    captured?.cancel();
  }

  dispatch(event: MouseEvent) {
    // A fresh press also recovers from a release lost outside the terminal window.
    if (event.kind === "press") this.cancelCapture();
    if (this.captured) this.captured.handle(event);
    else this.emit("mouse", event);
  }
}

/** XTerm mouse and focus reports, including reports split across stream chunks. */
export class MouseDecoder {
  private pending = "";
  constructor(
    private readonly mouse: (event: MouseEvent) => void,
    private readonly focus?: (focused: boolean) => void
  ) {}
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
      // eslint-disable-next-line no-control-regex -- Consume terminal reports before Ink sees keys.
      const index = text.search(/\x1b\[(?:<|[IO])/);
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
      if (text[2] === "I" || text[2] === "O") {
        this.focus?.(text[2] === "I");
        text = text.slice(3);
        continue;
      }
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
            kind: code & 64 ? "wheel" : match[4] === "m" ? "release" : code & 32 ? "drag" : "press",
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
  // Ink reads one key event per read(). Preserve source chunks when a slow render
  // leaves text and a following Enter buffered together.
  const input = new PassThrough({ objectMode: true }) as PassThrough & {
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
  const decoder = new MouseDecoder((event) => mouse.dispatch(event), setAnimationFocused);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const feed = (chunk: Buffer | string) => {
    clearTimeout(timer);
    const result = decoder.feed(String(chunk));
    if (result) {
      mouse.cancelCapture();
      // Some PTYs deliver an isolated Enter as LF or CRLF. Preserve multiline paste.
      input.write(result === "\n" || result === "\r\n" ? "\r" : result);
    }
    // A lone Esc remains an ordinary key; incomplete mouse reports stay bounded to 64 bytes.
    timer = setTimeout(() => {
      const rest = decoder.flush();
      if (rest === "\x1b" || rest === "\x1b[") {
        mouse.cancelCapture();
        input.write(rest);
      }
    }, 25);
  };
  source.setEncoding("utf8");
  source.on("data", feed);
  const interactive = !!stdout.isTTY && !!source.isTTY && process.env.TERM !== "dumb";
  const fullscreen = interactive ? fullscreenOutput(stdout) : undefined;
  if (interactive) {
    setAnimationFocused(true);
    stdout.write("\x1b[?1049h\x1b[H\x1b[?1002h\x1b[?1006h\x1b[?1004h");
  }
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    fullscreen?.close();
    clearTimeout(timer);
    source.removeListener("data", feed);
    mouse.cancelCapture();
    input.destroy();
    if (source.isTTY) source.setRawMode(!!wasRaw);
    if (wasPaused) source.pause();
    if (interactive) {
      setAnimationFocused(true);
      stdout.write("\x1b[?1004l\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[0m\x1b[?25h\x1b[?1049l");
    }
  };
  return {
    input: input as unknown as NodeJS.ReadStream,
    output: fullscreen?.stream ?? stdout,
    close,
  };
}

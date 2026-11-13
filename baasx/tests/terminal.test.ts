import { describe, test, expect } from "bun:test";
import { PassThrough } from "node:stream";
import {
  MouseBus,
  MouseDecoder,
  terminalSession,
  terminalViewport,
  type MouseEvent,
} from "../src/terminal";
import { marqueeText } from "../src/terminal-components";
import { displayWidth } from "../src/ui";

describe("terminal interaction protocol", () => {
  test("decodes split mouse reports without sending coordinate text to input", () => {
    const events: MouseEvent[] = [];
    const decoder = new MouseDecoder((event) => events.push(event));
    expect(decoder.feed("abc\x1b[<0;12;")).toBe("abc");
    expect(decoder.flush()).toBe("");
    expect(decoder.feed("8M\x1b[<0;12;8m\x1b[<64;12;8Mtail")).toBe("tail");
    expect(events).toEqual([
      { kind: "press", button: 0, x: 11, y: 7, delta: 0 },
      { kind: "release", button: 0, x: 11, y: 7, delta: 0 },
      { kind: "wheel", button: 0, x: 11, y: 7, delta: -3 },
    ]);
    expect(decoder.feed("\x1b[<65;2;3M")).toBe("");
    expect(events.at(-1)?.delta).toBe(3);
  });
  test("SGR button motion stays distinct from clicks, including split and modified packets", () => {
    const events: MouseEvent[] = [];
    const decoder = new MouseDecoder((event) => events.push(event));
    expect(decoder.feed("\x1b[<0;68;11M\x1b[<32;82;")).toBe("");
    expect(decoder.feed("4M\x1b[<48;90;3M\x1b[<0;90;3m")).toBe("");
    expect(events.map((event) => [event.kind, event.button, event.x, event.y])).toEqual([
      ["press", 0, 67, 10],
      ["drag", 0, 81, 3],
      ["drag", 0, 89, 2],
      ["release", 0, 89, 2],
    ]);
  });
  test("focus reports are consumed across every split boundary while mouse and arrow input survive", () => {
    for (const split of [1, 2]) {
      const focused: boolean[] = [];
      const events: MouseEvent[] = [];
      const decoder = new MouseDecoder(
        (event) => events.push(event),
        (value) => focused.push(value)
      );
      const report = "\x1b[O";
      expect(decoder.feed(`before${report.slice(0, split)}`)).toBe("before");
      expect(decoder.feed(`${report.slice(split)}\x1b[A\x1b[<32;9;4M\x1b[Iafter`)).toBe(
        "\x1b[Aafter"
      );
      expect(focused).toEqual([false, true]);
      expect(events).toEqual([{ kind: "drag", button: 0, x: 8, y: 3, delta: 0 }]);
      expect(decoder.flush()).toBe("");
      expect(decoder.feed("\x1b[<0;9;")).toBe("");
      expect(decoder.feed("\x1b[O\x1b[D")).toBe("\x1b[D");
      expect(focused.at(-1)).toBe(false);
      expect(decoder.feed("\x1b")).toBe("");
      expect(decoder.flush()).toBe("\x1b");
    }
  });
  test("mouse capture isolates drag events and a fresh click recovers a missing release", () => {
    const mouse = new MouseBus();
    const ordinary: string[] = [],
      captured: string[] = [];
    let cancelled = 0;
    mouse.on("mouse", (event: MouseEvent) => ordinary.push(event.kind));
    const release = mouse.capture(
      (event) => captured.push(event.kind),
      () => cancelled++
    );
    mouse.dispatch({ kind: "drag", button: 0, x: 20, y: 3, delta: 0 });
    mouse.dispatch({ kind: "wheel", button: 0, x: 20, y: 3, delta: -3 });
    expect(captured).toEqual(["drag", "wheel"]);
    expect(ordinary).toEqual([]);
    mouse.dispatch({ kind: "press", button: 0, x: 20, y: 3, delta: 0 });
    expect(cancelled).toBe(1);
    expect(mouse.hasCapture).toBe(false);
    expect(ordinary).toEqual(["press"]);
    release();
  });
  test("ordinary escape and arrow keys survive while malformed mouse packets cannot become commands", () => {
    const decoder = new MouseDecoder(() => {});
    expect(decoder.feed("\x1b[A")).toBe("\x1b[A");
    expect(decoder.feed("\x1b")).toBe("");
    expect(decoder.flush()).toBe("\x1b");
    expect(decoder.feed("\x1b[<oopsM")).toBe("");
    expect(decoder.feed("\x1b[<0;99999;1M")).toBe("");
  });
  test("owns terminal modes, keeps capture through focus reports, and restores modes exactly once", () => {
    const previousTerm = process.env.TERM;
    process.env.TERM = "xterm-256color";
    const modes: boolean[] = [];
    const source = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode: (v: boolean) => modes.push(v),
      ref() {},
      unref() {},
    });
    let output = "";
    const target = Object.assign(new PassThrough(), { isTTY: true });
    target.on("data", (chunk) => (output += chunk));
    const mouse = new MouseBus();
    const session = terminalSession(
      source as unknown as NodeJS.ReadStream,
      target as unknown as NodeJS.WriteStream,
      mouse
    );
    // Ink drains its readable stream one event at a time even when it was busy
    // rendering while these separate input chunks arrived.
    source.write("/tasks");
    source.write("\r");
    expect(session.input.read()).toBe("/tasks");
    expect(session.input.read()).toBe("\r");
    source.write("\n");
    expect(session.input.read()).toBe("\r");
    source.write("paste\nlines");
    expect(session.input.read()).toBe("paste\nlines");
    let cancelled = 0;
    mouse.capture(
      () => {},
      () => cancelled++
    );
    let input = "";
    session.input.on("data", (chunk) => (input += chunk));
    source.write("\x1b[");
    source.write("O\x1b[I");
    expect(mouse.hasCapture).toBe(true);
    expect(cancelled).toBe(0);
    expect(input).toBe("");
    source.write("x");
    expect(input).toBe("x");
    expect(mouse.hasCapture).toBe(false);
    expect(cancelled).toBe(1);
    mouse.capture(
      () => {},
      () => cancelled++
    );
    session.close();
    expect(mouse.hasCapture).toBe(false);
    expect(cancelled).toBe(2);
    session.close();
    expect(output).toContain("\x1b[?1049h");
    expect(output).toContain("\x1b[?1006h");
    expect(output).toContain("\x1b[?1002h");
    expect(output).toContain("\x1b[?1004h");
    expect(output.match(/1004h/g)).toHaveLength(1);
    expect(output.match(/1004l/g)).toHaveLength(1);
    expect(output.match(/1002l/g)).toHaveLength(1);
    expect(output.match(/1049l/g)).toHaveLength(1);
    expect(modes.at(-1)).toBe(false);
    expect(source.listenerCount("data")).toBe(0);
    source.destroy();
    target.destroy();
    if (previousTerm === undefined) delete process.env.TERM;
    else process.env.TERM = previousTerm;
  });
});
test("long labels bounce across their entire content without breaking CJK or combining characters", () => {
  const source = "ABCDEFGHIJK结束";
  const frames = Array.from({ length: 70 }, (_, i) => marqueeText(source, 6, i));
  expect(frames.some((frame) => frame.includes("结束"))).toBe(true);
  expect(frames.at(-1)).not.toBeUndefined();
  for (const value of frames) expect(displayWidth(value)).toBeLessThanOrEqual(6);
  expect(marqueeText("界👩‍💻é末尾", 4, 6)).not.toContain("\uFFFD");
});

function screenFixture(interactive = true) {
  const previousTerm = process.env.TERM;
  process.env.TERM = "xterm-256color";
  const source = Object.assign(new PassThrough(), {
    isTTY: interactive,
    isRaw: false,
    setRawMode() {},
    ref() {},
    unref() {},
  });
  const chunks: string[] = [];
  const target = Object.assign(new PassThrough(), { isTTY: interactive, rows: 4, columns: 12 });
  target.on("data", (chunk) => chunks.push(String(chunk)));
  const session = terminalSession(
    source as unknown as NodeJS.ReadStream,
    target as unknown as NodeJS.WriteStream,
    new MouseBus()
  );
  chunks.length = 0;
  return {
    chunks,
    target,
    session,
    write: (text: string) =>
      new Promise<void>((resolve, reject) => {
        session.output.write(text, (error) => (error ? reject(error) : resolve()));
      }),
    close() {
      session.close();
      source.destroy();
      target.destroy();
      if (previousTerm === undefined) delete process.env.TERM;
      else process.env.TERM = previousTerm;
    },
  };
}

const inkErase = (count: number) =>
  Array.from({ length: count }, (_, i) => `\x1b[2K${i < count - 1 ? "\x1b[1A" : ""}`).join("") +
  (count ? "\x1b[G" : "");

test("interactive output uses every physical row without scrolling the last line", async () => {
  const screen = screenFixture();
  try {
    expect(terminalViewport(screen.session.output)).toBe(
      screen.target as unknown as NodeJS.WriteStream
    );
    expect(screen.session.output.columns).toBe(12);
    expect(screen.session.output.rows).toBe(5);
    await screen.write("Title\nBody\nInput\nFooter\n");
    expect(screen.chunks).toEqual(["\x1b[H\x1b[2KTitle\n\x1b[2KBody\n\x1b[2KInput\n\x1b[2KFooter"]);
    await screen.write(inkErase(5) + "Title\nShort\nInput\nNew footer\n");
    expect(screen.chunks.at(-1)).toBe(
      "\x1b[H\x1b[2KTitle\n\x1b[2KShort\n\x1b[2KInput\n\x1b[2KNew footer"
    );
    expect(screen.chunks.every((chunk) => !chunk.endsWith("\n"))).toBe(true);
    expect(screen.chunks.join("")).not.toContain("\x1b[2J");
    expect(screen.chunks.join("")).not.toContain("\x1b[3J");
  } finally {
    screen.close();
  }
});

test("console output and Ink clear operations retain their contents between complete frames", async () => {
  const screen = screenFixture();
  try {
    await screen.write("Title\nBody\nInput\nFooter\n");
    await screen.write(inkErase(5));
    await screen.write("ordinary diagnostic\n");
    await screen.write("second line\nthird line\n");
    expect(screen.chunks.slice(1)).toEqual([
      inkErase(5),
      "ordinary diagnostic\n",
      "second line\nthird line\n",
    ]);
    await screen.write("Title\nBody\nInput\nFooter\n");
    expect(screen.chunks.at(-1)?.startsWith("\x1b[H")).toBe(true);
    expect(screen.chunks.at(-1)?.endsWith("\x1b[2KFooter")).toBe(true);
  } finally {
    screen.close();
  }
});

test("resize keeps Ink's guard high and skips stale dimensions before the next complete frame", async () => {
  const screen = screenFixture();
  try {
    let resizes = 0;
    screen.session.output.on("resize", () => resizes++);
    await screen.write("Title\nBody\nInput\nFooter\n");
    screen.target.rows = 3;
    screen.target.columns = 8;
    screen.target.emit("resize");
    expect(resizes).toBe(1);
    expect(screen.session.output.rows).toBe(5);
    expect(terminalViewport(screen.session.output).rows).toBe(3);
    await screen.write(inkErase(5) + "Title\nOld body\nInput\nFooter\n");
    await screen.write(inkErase(5) + "Old wide title\nBody\nFooter\n");
    expect(screen.chunks).toHaveLength(1);
    await screen.write(inkErase(4) + "Title\nInput\nFooter\n");
    expect(screen.chunks.at(-1)).toBe("\x1b[H\x1b[2KTitle\n\x1b[2KInput\n\x1b[2KFooter");
    screen.target.rows = 6;
    screen.target.columns = 12;
    screen.target.emit("resize");
    expect(screen.session.output.rows).toBe(7);
    expect(screen.session.output.columns).toBe(12);
    await screen.write(inkErase(4) + "Title\nInput\nFooter\n");
    expect(screen.chunks).toHaveLength(2);
    await screen.write(inkErase(4) + "Title\n\n\n\nInput\nFooter\n");
    expect(screen.chunks).toHaveLength(3);
    expect(screen.chunks.at(-1)?.split("\n")).toHaveLength(6);
    expect(resizes).toBe(2);
  } finally {
    screen.close();
  }
});

test("closing a fullscreen session detaches resize and ignores late frame writes", async () => {
  const screen = screenFixture();
  try {
    expect(screen.target.listenerCount("resize")).toBe(1);
    screen.session.close();
    const closedOutput = [...screen.chunks];
    expect(screen.target.listenerCount("resize")).toBe(0);
    await screen.write("Title\nBody\nInput\nFooter\n");
    await screen.write("late diagnostic\n");
    screen.target.emit("resize");
    expect(screen.chunks).toEqual(closedOutput);
  } finally {
    screen.close();
  }
});

test("redirected terminal output keeps the original stream and newline semantics", async () => {
  const screen = screenFixture(false);
  try {
    expect(screen.session.output).toBe(screen.target as unknown as NodeJS.WriteStream);
    expect(terminalViewport(screen.session.output)).toBe(
      screen.target as unknown as NodeJS.WriteStream
    );
    expect(screen.session.output.rows).toBe(4);
    await screen.write("Title\nBody\nInput\nFooter\n");
    expect(screen.chunks).toEqual(["Title\nBody\nInput\nFooter\n"]);
    expect(screen.target.listenerCount("resize")).toBe(0);
  } finally {
    screen.close();
  }
});

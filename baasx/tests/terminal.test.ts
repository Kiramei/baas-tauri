import { describe, test, expect } from "bun:test";
import { PassThrough } from "node:stream";
import { MouseBus, MouseDecoder, terminalSession, type MouseEvent } from "../src/terminal";
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
  test("ordinary escape and arrow keys survive while malformed mouse packets cannot become commands", () => {
    const decoder = new MouseDecoder(() => {});
    expect(decoder.feed("\x1b[A")).toBe("\x1b[A");
    expect(decoder.feed("\x1b")).toBe("");
    expect(decoder.flush()).toBe("\x1b");
    expect(decoder.feed("\x1b[<oopsM")).toBe("");
    expect(decoder.feed("\x1b[<0;99999;1M")).toBe("");
  });
  test("owns alternate screen and restores raw mode and mouse on cleanup exactly once", () => {
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
    const session = terminalSession(
      source as unknown as NodeJS.ReadStream,
      target as unknown as NodeJS.WriteStream,
      new MouseBus()
    );
    session.close();
    session.close();
    expect(output).toContain("\x1b[?1049h");
    expect(output).toContain("\x1b[?1006h");
    expect(output.match(/1049l/g)).toHaveLength(1);
    expect(modes.at(-1)).toBe(false);
    expect(source.listenerCount("data")).toBe(0);
    source.destroy();
    target.destroy();
    process.env.TERM = previousTerm;
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

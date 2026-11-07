import React from "react";
import { expect, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import { Box, render } from "ink";
import chalk from "chalk";
import { AnimationClock } from "../src/motion";
import { ActivityText, Marquee, Sparkle, wrapTerminalText } from "../src/terminal-components";
import { displayWidth, terminalText } from "../src/ui";

test("the animation clock serves multiple effects and stops after the last unmount", async () => {
  const clock = new AnimationClock();
  let first = 0,
    second = 0;
  const stopFirst = clock.subscribe(() => first++);
  const stopSecond = clock.subscribe(() => second++);
  try {
    await Bun.sleep(180);
    expect(first).toBeGreaterThan(0);
    expect(first).toBe(second);
    stopFirst();
    const previous = first;
    await Bun.sleep(100);
    expect(first).toBe(previous);
    expect(second).toBeGreaterThan(first);
    stopSecond();
    const stopped = clock.snapshot();
    await Bun.sleep(100);
    expect(clock.snapshot()).toBe(stopped);
  } finally {
    stopFirst();
    stopSecond();
  }
});

function mount(children: React.ReactNode, isTTY = true) {
  const frames: string[] = [];
  const rawFrames: string[] = [];
  const stdout = Object.assign(
    new Writable({
      write(chunk, _, done) {
        const text = terminalText(String(chunk));
        if (text.trim()) {
          frames.push(text);
          rawFrames.push(String(chunk));
        }
        done();
      },
    }),
    { columns: 40, rows: 8, isTTY }
  );
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode() {},
    ref() {},
    unref() {},
  });
  const app = render(children, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    patchConsole: false,
    maxFps: 1000,
  });
  return {
    frames,
    rawFrames,
    rerender(children: React.ReactNode) {
      app.rerender(children);
    },
    close() {
      app.unmount();
      app.cleanup();
      stdin.destroy();
      stdout.destroy();
    },
  };
}

function motionEnvironment(reduced: boolean) {
  const previousTerm = process.env.TERM;
  const previousMotion = process.env.BAAS_REDUCED_MOTION;
  process.env.TERM = "xterm-256color";
  process.env.BAAS_REDUCED_MOTION = reduced ? "1" : "0";
  return () => {
    if (previousTerm === undefined) delete process.env.TERM;
    else process.env.TERM = previousTerm;
    if (previousMotion === undefined) delete process.env.BAAS_REDUCED_MOTION;
    else process.env.BAAS_REDUCED_MOTION = previousMotion;
  };
}

test("activity animates locally without rerendering its parent or changing row width", async () => {
  const restore = motionEnvironment(false);
  let renders = 0;
  function Parent() {
    renders++;
    return <ActivityText value="Working" width={12} active />;
  }
  const ui = mount(<Parent />);
  try {
    await Bun.sleep(1050);
    expect(renders).toBe(1);
    expect(new Set(ui.frames).size).toBeGreaterThan(4);
    for (const frame of ui.frames) {
      expect(frame).toContain("Working");
      expect(displayWidth(frame.trimEnd())).toBe(9);
    }
  } finally {
    ui.close();
    restore();
  }
});

test("reduced motion retains status and labels without repainting idle frames", async () => {
  const restore = motionEnvironment(true);
  const ui = mount(
    <Box flexDirection="column">
      <Sparkle />
      <Marquee value="A long label that would otherwise scroll" width={12} />
      <ActivityText value="Running" width={12} active mode="tool-use" />
    </Box>
  );
  try {
    await Bun.sleep(50);
    const count = ui.frames.length;
    expect(count).toBeGreaterThan(0);
    await Bun.sleep(260);
    expect(ui.frames).toHaveLength(count);
    expect(ui.frames.at(-1)).toContain("A long label");
    expect(ui.frames.at(-1)).toContain("● Running");
  } finally {
    ui.close();
    restore();
  }
});

test("breathing and sweep colors change between star frames without rerendering the parent", async () => {
  const restore = motionEnvironment(false);
  const previousLevel = chalk.level;
  chalk.level = 3;
  try {
    for (const mode of ["tool-use", "requesting"] as const) {
      let renders = 0;
      function Parent() {
        renders++;
        return <ActivityText value="Working" width={12} active mode={mode} />;
      }
      const ui = mount(<Parent />);
      try {
        await Bun.sleep(1500);
        expect(renders).toBe(1);
        expect(ui.rawFrames.some((frame) => frame.includes("\x1b[38;2;"))).toBe(true);
        const colorsByText = new Map<string, Set<string>>();
        for (const frame of ui.rawFrames) {
          const plain = terminalText(frame);
          const versions = colorsByText.get(plain) ?? new Set<string>();
          versions.add(frame);
          colorsByText.set(plain, versions);
          expect(displayWidth(plain.trimEnd())).toBe(9);
        }
        expect([...colorsByText.values()].some((versions) => versions.size > 1)).toBe(true);
      } finally {
        ui.close();
      }
    }
  } finally {
    chalk.level = previousLevel;
    restore();
  }
}, 10000);

test("deactivating a busy label stops its motion and retains the status text", async () => {
  const restore = motionEnvironment(false);
  const ui = mount(<ActivityText value="Waiting" width={12} active mode="tool-use" />);
  try {
    await Bun.sleep(180);
    ui.rerender(<ActivityText value="Confirm" width={12} active={false} mode="tool-use" />);
    await Bun.sleep(50);
    const count = ui.frames.length;
    await Bun.sleep(260);
    expect(ui.frames).toHaveLength(count);
    expect(ui.frames.at(-1)?.trim()).toBe("Confirm");
  } finally {
    ui.close();
    restore();
  }
});

test("idle, redirected and dumb terminals do not repaint animation frames", async () => {
  const restore = motionEnvironment(false);
  try {
    for (const mode of ["idle", "redirected", "dumb"] as const) {
      process.env.TERM = mode === "dumb" ? "dumb" : "xterm-256color";
      const ui = mount(
        <ActivityText value="Ready" width={12} active={mode !== "idle"} mode="requesting" />,
        mode !== "redirected"
      );
      try {
        await Bun.sleep(50);
        const count = ui.frames.length;
        expect(count).toBeGreaterThan(0);
        await Bun.sleep(260);
        expect(ui.frames).toHaveLength(count);
        expect(ui.frames.at(-1)).toContain("Ready");
      } finally {
        ui.close();
      }
    }
  } finally {
    restore();
  }
});

test("one-cell viewports preserve graphemes without overflowing adjacent controls", () => {
  const lines = wrapTerminalText("界👩‍💻é\nAB", 1);
  expect(lines).toEqual(["…", "…", "é", "A", "B"]);
  for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(1);
  expect(wrapTerminalText("界👩‍💻é", 4)).toEqual(["界👩‍💻", "é"]);
});

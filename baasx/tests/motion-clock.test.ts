import { expect, test } from "bun:test";
import { createElement } from "react";
import { PassThrough, Writable } from "node:stream";
import { render, Text } from "ink";
import { AnimationClock, useAnimation } from "../src/motion";

test("a delayed animation tick catches up to elapsed time", async () => {
  const clock = new AnimationClock();
  const stop = clock.subscribe(() => {});
  try {
    // Simulate synchronous work delaying the first timer callback. Counting
    // callbacks would only advance one frame after this pause.
    Bun.sleepSync(100);
    await Bun.sleep(20);
    expect(clock.timeSnapshot(50)).toBeGreaterThanOrEqual(100);
    expect(clock.snapshot(50)).toBeGreaterThanOrEqual(2);
  } finally {
    stop();
  }
});

test("focus changes preserve elapsed time and cannot restart an idle clock", async () => {
  const clock = new AnimationClock();
  let updates = 0;
  const stop = clock.subscribe(() => updates++);
  try {
    await Bun.sleep(65);
    const beforeBlur = clock.timeSnapshot(16);
    expect(beforeBlur).toBeGreaterThan(0);
    clock.setFocused(false);
    await Bun.sleep(70);
    expect(clock.timeSnapshot(16)).toBeGreaterThan(beforeBlur);
    stop();
    const stoppedTime = clock.timeSnapshot(16);
    const stoppedUpdates = updates;
    clock.setFocused(true);
    clock.setFocused(false);
    await Bun.sleep(70);
    expect(clock.timeSnapshot(16)).toBe(stoppedTime);
    expect(updates).toBe(stoppedUpdates);
  } finally {
    stop();
  }
});

test("resuming the clock excludes the fully idle interval", async () => {
  const clock = new AnimationClock();
  let stop = clock.subscribe(() => {});
  try {
    await Bun.sleep(40);
    stop();
    const frozen = clock.timeSnapshot(16);
    await Bun.sleep(160);
    expect(clock.timeSnapshot(16)).toBe(frozen);
    const resumedAt = performance.now();
    stop = clock.subscribe(() => {});
    await Bun.sleep(40);
    const resumed = clock.timeSnapshot(16);
    expect(resumed).toBeGreaterThan(frozen);
    // Had idle time been counted, the first tick would jump by at least 160ms.
    expect(resumed - frozen).toBeLessThanOrEqual(performance.now() - resumedAt + 16);
  } finally {
    stop();
  }
});

test("inactive, noninteractive and reduced-motion effects never animate", async () => {
  const originalTerm = process.env.TERM;
  const originalMotion = process.env.BAAS_REDUCED_MOTION;
  try {
    for (const scenario of [
      { active: false, tty: true, term: "xterm", reduced: "0" },
      { active: true, tty: false, term: "xterm", reduced: "0" },
      { active: true, tty: true, term: "dumb", reduced: "0" },
      { active: true, tty: true, term: "xterm", reduced: "true" },
    ]) {
      process.env.TERM = scenario.term;
      process.env.BAAS_REDUCED_MOTION = scenario.reduced;
      const states: { time: number; enabled: boolean }[] = [];
      const stdout = Object.assign(
        new Writable({
          write(_chunk, _encoding, done) {
            done();
          },
        }),
        {
          isTTY: scenario.tty,
          columns: 40,
          rows: 8,
        }
      );
      const stdin = Object.assign(new PassThrough(), {
        isTTY: true,
        setRawMode() {},
        ref() {},
        unref() {},
      });
      function Probe() {
        const state = useAnimation(scenario.active, 50);
        states.push(state);
        return createElement(Text, null, String(state.time));
      }
      const app = render(createElement(Probe), {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        debug: true,
        patchConsole: false,
      });
      try {
        await Bun.sleep(110);
        expect(states).toEqual([{ time: 0, enabled: false }]);
      } finally {
        app.unmount();
        app.cleanup();
        stdin.destroy();
        stdout.destroy();
      }
    }
  } finally {
    if (originalTerm === undefined) delete process.env.TERM;
    else process.env.TERM = originalTerm;
    if (originalMotion === undefined) delete process.env.BAAS_REDUCED_MOTION;
    else process.env.BAAS_REDUCED_MOTION = originalMotion;
  }
});

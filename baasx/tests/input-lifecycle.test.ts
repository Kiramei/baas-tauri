import { expect, test } from "bun:test";

test.each(["select", "priority"])(
  "newly mounted and reactivated %s editors receive keys before passive effects, with exact cleanup",
  async (kind) => {
    const child = Bun.spawn(
      [process.execPath, `${import.meta.dir}/fixtures/input-lifecycle.tsx`, kind],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NODE_ENV: "development" },
        signal: AbortSignal.timeout(8_000),
      }
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, stderr).toBe(0);
    const result = JSON.parse(stdout);
    expect(result).toEqual({
      initial: 1,
      mounted: 2,
      inactive: 1,
      reactivated: 2,
      unmounted: 1,
      finished: 0,
      readers: 0,
      values:
        kind === "priority"
          ? [
              ["scrcpy", "adb"],
              ["adb", "scrcpy"],
            ]
          : ["scrcpy", "adb"],
      modes: [true, false],
    });
  },
  10_000
);

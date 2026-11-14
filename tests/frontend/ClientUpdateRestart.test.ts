import { expect, test } from "bun:test";
import { restartUpdatedDesktopClient, type ClientUpdateResult } from "../../src/shared/ClientUpdateRestart";

test("portable managed restart never relaunches the old executable", async () => {
  let calls = 0;
  await restartUpdatedDesktopClient({ restartManaged: true }, async () => { calls++; });
  expect(calls).toBe(0);
});

test("an installed desktop update relaunches exactly once", async () => {
  let calls = 0;
  await restartUpdatedDesktopClient(true, async () => { calls++; });
  expect(calls).toBe(1);
});

test("an up-to-date response does not restart", async () => {
  let calls = 0;
  await restartUpdatedDesktopClient(false, async () => { calls++; });
  expect(calls).toBe(0);
});

test("unknown native response fails closed without launching an old client", async () => {
  let calls = 0;
  await expect(restartUpdatedDesktopClient({ restartManaged: false } as unknown as ClientUpdateResult, async () => { calls++; })).rejects.toThrow("Unsupported client update result");
  expect(calls).toBe(0);
});

test("installed-client relaunch failures reach the update error UI", async () => {
  await expect(restartUpdatedDesktopClient(true, async () => { throw new Error("relaunch failed"); })).rejects.toThrow("relaunch failed");
});

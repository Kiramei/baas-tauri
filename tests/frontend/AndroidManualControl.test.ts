import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  androidManualControl,
  resumeAndroidAutomationBeforeStart,
  verifyAndroidManualControlOwnership,
} from "../../src/shared/AndroidManualControl";

function fixture() {
  const calls: any[] = [];
  let callback: ((response: any) => void) | undefined;
  const state: any = {
    statusStore: { own: { running: true } },
    connections: { trigger: { readyState: 1 } },
    pendingCallbacks: {},
    trigger(request: any, listener: (response: any) => void) {
      calls.push(request);
      callback = (response: any) => listener(response);
      state.pendingCallbacks[42] = callback;
      return 42;
    },
  };
  return { state, calls, reply: (response: any) => callback!(response) };
}

describe("Android manual game control", () => {
  test("only explicit Start re-enables input on the owned non-primary display", async () => {
    androidManualControl.setActive(false);
    const calls: number[] = [];
    const resume = async ({ displayId }: { displayId: number }) => {
      calls.push(displayId);
      return { resumed: true };
    };
    for (const invalid of [0, -1, NaN, Infinity, 1.5])
      await expect(resumeAndroidAutomationBeforeStart(invalid, resume)).rejects.toThrow();
    expect(calls).toEqual([]);
    expect(await resumeAndroidAutomationBeforeStart(4, resume)).toBe(true);
    expect(calls).toEqual([4]);
    androidManualControl.setActive(true);
    expect(await resumeAndroidAutomationBeforeStart(4, resume)).toBe(false);
    expect(calls).toEqual([4]);
    androidManualControl.setActive(false);
  });
  test("late resume acknowledgement cannot start a scheduler after manual entry", async () => {
    androidManualControl.setActive(false);
    let reply!: (result: { resumed: boolean }) => void;
    const pending = resumeAndroidAutomationBeforeStart(
      4,
      () =>
        new Promise((resolve) => {
          reply = resolve;
        })
    );
    androidManualControl.setActive(true);
    reply({ resumed: true });
    expect(await pending).toBe(false);
    androidManualControl.setActive(false);
    await expect(
      resumeAndroidAutomationBeforeStart(4, async () => ({ resumed: false }))
    ).rejects.toThrow("not enabled");
  });
  test("running own scheduler remains running; entry only queries ownership", async () => {
    const f = fixture();
    let finished = false;
    const pending = verifyAndroidManualControlOwnership(() => f.state, "own").then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(f.calls[0].command).toBe("status");
    f.reply({ status: "ok", data: { own: { running: true } } });
    await pending;
    expect(finished).toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(f.state.statusStore.own.running).toBe(true);
  });
  test("idle own profile can enter without any scheduler mutation", async () => {
    const f = fixture();
    f.state.statusStore.own.running = false;
    const pending = verifyAndroidManualControlOwnership(() => f.state, "own");
    expect(f.calls[0].command).toBe("status");
    f.reply({ status: "ok", data: {} });
    await pending;
  });
  test("another running profile fails closed without stopping it", async () => {
    const f = fixture();
    f.state.statusStore.other = { running: true };
    await expect(verifyAndroidManualControlOwnership(() => f.state, "own")).rejects.toThrow(
      "Another profile"
    );
    expect(f.calls).toHaveLength(0);
  });
  test("foreign or malformed authoritative ownership fails without stopping anything", async () => {
    for (const status of [
      { other: { running: true } },
      { own: null },
      { own: { running: "true" } },
    ]) {
      const f = fixture();
      const pending = verifyAndroidManualControlOwnership(() => f.state, "own");
      f.reply({ status: "ok", data: status });
      await expect(pending).rejects.toThrow();
    }
  });
  test("backend errors, malformed status and disconnected channel prevent control", async () => {
    for (const reply of [
      { status: "error", error: "denied" },
      { status: "ok", data: [] },
    ]) {
      const f = fixture();
      const pending = verifyAndroidManualControlOwnership(() => f.state, "own");
      f.reply(reply);
      await expect(pending).rejects.toThrow();
    }
    const f = fixture();
    f.state.connections.trigger.readyState = 3;
    await expect(verifyAndroidManualControlOwnership(() => f.state, "own")).rejects.toThrow(
      "unavailable"
    );
  });
  test("timeout clears only its allocated callback and does not enable manual control", async () => {
    const f = fixture();
    const unrelated = () => {};
    f.state.pendingCallbacks[10] = unrelated;
    await expect(verifyAndroidManualControlOwnership(() => f.state, "own", 5)).rejects.toThrow(
      "timed out"
    );
    expect(f.state.pendingCallbacks[42]).toBeUndefined();
    expect(f.state.pendingCallbacks[10]).toBe(unrelated);
  });
  test("manual mode gates idle updates and the bottom start shortcut", () => {
    androidManualControl.setActive(true);
    expect(androidManualControl.isActive()).toBe(true);
    androidManualControl.setActive(false);
    expect(androidManualControl.isActive()).toBe(false);
    const updater = readFileSync(
      new URL("../../src/components/IdleBackendUpdater.tsx", import.meta.url),
      "utf8"
    );
    expect(updater).toContain("if (__WITH_ANDROID__ && androidManualControl.isActive()) return;");
    const home = readFileSync(new URL("../../src/pages/HomePage.tsx", import.meta.url), "utf8");
    expect(home).toContain("if (androidManualControl.isActive()) return;");
    const panel = readFileSync(
      new URL("../../src/android/components/AndroidGamePanel.tsx", import.meta.url),
      "utf8"
    );
    expect(panel).toContain('invoke<{ active: boolean }>("android_game_fullscreen"');
    expect(panel).not.toContain('invoke("android_launch_game"');
    const enter = panel.slice(
      panel.indexOf("const takeOverGame"),
      panel.indexOf("const restartGame")
    );
    expect(enter).not.toContain("onToggleVirtualDisplay(false");
    expect(enter.indexOf("await onBeforeManualControl()")).toBeLessThan(
      enter.indexOf('"android_game_fullscreen"')
    );
  });
  test("manual entry and backend installation cannot claim the session concurrently", () => {
    androidManualControl.setActive(false);
    expect(androidManualControl.begin()).toBe(true);
    expect(androidManualControl.begin()).toBe(false);
    expect(androidManualControl.beginBackendUpdate()).toBe(false);
    androidManualControl.setActive(false);
    expect(androidManualControl.beginBackendUpdate()).toBe(true);
    expect(androidManualControl.begin()).toBe(false);
    androidManualControl.endBackendUpdate();
    expect(androidManualControl.begin()).toBe(true);
    androidManualControl.setActive(false);
  });
});

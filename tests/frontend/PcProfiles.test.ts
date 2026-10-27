import { describe, expect, test } from "bun:test";
import {
  buildServerOptions,
  isPcServer,
  SERVER_VALUES,
  supportsPcServers,
} from "../../src/shared/serverOptions";
import { serverMap, serverMapSpec } from "../../src/shared/GlobalUtilities";
import {
  configureNewPcProfile,
  PC_DEFAULT_METHODS,
  pcMethodOptions,
  validPcMethods,
} from "../../src/shared/PcProfiles";

describe("PC profiles use the native Windows host", () => {
  test("Windows browsers, Android, macOS and Linux do not offer PC profile creation", () => {
    const windows = { tauri: true, android: false, platform: "Win32" };
    expect(supportsPcServers(windows)).toBe(true);
    for (const environment of [
      { ...windows, tauri: false },
      { ...windows, android: true },
      { ...windows, platform: "Linux x86_64" },
      { ...windows, platform: "MacIntel" },
    ])
      expect(supportsPcServers(environment)).toBe(false);
  });

  test("imported PC profiles retain their label without enabling unsupported creation", () => {
    const t = ((key: string) => key) as any;
    expect(buildServerOptions(t)).toHaveLength(6);
    expect(buildServerOptions(t, { includePc: true })).toHaveLength(8);
    for (const selected of [SERVER_VALUES.JP_PC, SERVER_VALUES.GLOBAL_PC]) {
      expect(isPcServer(selected)).toBe(true);
      expect(buildServerOptions(t, { selected }).at(-1)).toMatchObject({
        value: selected,
        disabled: true,
      });
    }
    expect(isPcServer(SERVER_VALUES.JP)).toBe(false);
    expect(isPcServer(undefined)).toBe(false);
    expect(serverMap[SERVER_VALUES.JP_PC]).toBe("JP");
    expect(serverMapSpec[SERVER_VALUES.JP_PC]).toBe("JP");
    expect(serverMap[SERVER_VALUES.GLOBAL_PC]).toBe("Global");
    expect(serverMapSpec[SERVER_VALUES.GLOBAL_PC]).toBe("Global_en-us");
  });

  test("invalid imported methods stay visible until the user repairs them", () => {
    expect(pcMethodOptions("uiautomator2", "screenshot", true)).toEqual([
      { value: "mss", disabled: false },
      { value: "pyautogui", disabled: false },
      { value: "uiautomator2", disabled: true },
    ]);
    expect(pcMethodOptions("adb", "control", false)).toEqual([
      { value: "pyautogui", disabled: true },
      { value: "adb", disabled: true },
    ]);
    expect(validPcMethods("mss", "pyautogui")).toBe(true);
    expect(validPcMethods("pyautogui", "pyautogui")).toBe(true);
    expect(validPcMethods("uiautomator2", "pyautogui")).toBe(false);
    expect(validPcMethods("mss", "adb")).toBe(false);
  });
});

function fixture() {
  const writes: unknown[] = [];
  const pulls: unknown[] = [];
  let reads = 0;
  const state = {
    _auth_phase: "authenticated",
    _session: {},
    connections: { sync: { readyState: 1 } },
    configStore: {
      pc: {
        server: SERVER_VALUES.JP_PC,
        screenshot_method: "uiautomator2",
        control_method: "uiautomator2",
      },
    },
    modify: (path: string, patch: unknown) => writes.push([path, patch]),
    send: (channel: string, message: unknown) => pulls.push([channel, message]),
  };
  return {
    state,
    writes,
    pulls,
    getState: () => {
      reads += 1;
      return state as any;
    },
    readCount: () => reads,
  };
}

describe("PC creation confirms backend persistence", () => {
  test("a local write alone never marks the methods as saved", async () => {
    const store = fixture();
    let completed = false;
    const saving = configureNewPcProfile(store.getState, "pc", {
      intervalMs: 1,
      timeoutMs: 100,
    }).then(() => {
      completed = true;
    });
    expect(store.writes).toEqual([["pc::config", PC_DEFAULT_METHODS]]);
    expect(store.pulls).toEqual([
      ["sync", { type: "pull", resource: "config", resource_id: "pc" }],
    ]);
    await Bun.sleep(3);
    expect(completed).toBe(false);
    Object.assign(store.state.configStore.pc, PC_DEFAULT_METHODS);
    await saving;
    expect(completed).toBe(true);
  });

  test("unconfirmed methods time out and stop reading state", async () => {
    const store = fixture();
    await expect(
      configureNewPcProfile(store.getState, "pc", { intervalMs: 1, timeoutMs: 4 })
    ).rejects.toThrow("not confirmed");
    const reads = store.readCount();
    await Bun.sleep(4);
    expect(store.readCount()).toBe(reads);
    expect(store.state.configStore.pc.screenshot_method).toBe("uiautomator2");
  });

  test("unmount cancellation clears the polling loop", async () => {
    const store = fixture();
    const controller = new AbortController();
    const saving = configureNewPcProfile(store.getState, "pc", {
      signal: controller.signal,
      intervalMs: 1,
    });
    controller.abort();
    await expect(saving).rejects.toThrow("cancelled");
    const reads = store.readCount();
    await Bun.sleep(4);
    expect(store.readCount()).toBe(reads);
  });

  test("session replacement fails instead of confirming another user's snapshot", async () => {
    const store = fixture();
    const saving = configureNewPcProfile(store.getState, "pc", { intervalMs: 1 });
    store.state._session = {};
    Object.assign(store.state.configStore.pc, PC_DEFAULT_METHODS);
    await expect(saving).rejects.toThrow("session changed");
  });

  test("unauthenticated or closed configuration channels never submit settings", async () => {
    for (const authenticated of [true, false]) {
      const store = fixture();
      if (authenticated) store.state.connections.sync.readyState = 3;
      else store.state._auth_phase = "idle";
      await expect(configureNewPcProfile(store.getState, "pc")).rejects.toThrow("unavailable");
      expect(store.writes).toEqual([]);
    }
  });
});

import { describe, expect, test } from "bun:test";
import { createNativeFullscreenController } from "../../src/shared/NativeFullscreen";

function nativeWindow(initialMaximized: boolean) {
  let fullscreen = false;
  let maximized = initialMaximized;
  let pendingRestoreReads = 0;
  let failEntry = false;
  const calls: string[] = [];
  return {
    calls,
    delayRestore() {
      pendingRestoreReads = 3;
    },
    failNextEntry() {
      failEntry = true;
    },
    async isFullscreen() {
      return fullscreen;
    },
    async isMaximized() {
      if (pendingRestoreReads > 0) {
        pendingRestoreReads -= 1;
        if (pendingRestoreReads === 0) maximized = false;
      }
      return maximized;
    },
    async unmaximize() {
      calls.push("restore");
      if (pendingRestoreReads === 0) maximized = false;
    },
    async maximize() {
      if (fullscreen) throw new Error("Cannot restore maximization before leaving fullscreen");
      calls.push("maximize");
      maximized = true;
    },
    async setFullscreen(value: boolean) {
      if (value && maximized) throw new Error("Maximized client area would be taskbar-clipped");
      if (value && failEntry) {
        failEntry = false;
        throw new Error("Native fullscreen rejected");
      }
      calls.push(value ? "enter" : "exit");
      fullscreen = value;
    },
  };
}

describe("native fullscreen transitions", () => {
  test("maximized entry restores the native window first and exit restores maximization", async () => {
    const appWindow = nativeWindow(true);
    const controller = createNativeFullscreenController();
    expect(await controller.toggle(appWindow)).toBe(true);
    expect(await appWindow.isMaximized()).toBe(false);
    expect(await controller.toggle(appWindow)).toBe(false);
    expect(await appWindow.isMaximized()).toBe(true);
    expect(appWindow.calls).toEqual(["restore", "enter", "exit", "maximize"]);
  });

  test("waits for asynchronous native restoration before entering fullscreen", async () => {
    const appWindow = nativeWindow(true);
    const controller = createNativeFullscreenController();
    // The initial state query and first post-command query still report maximized.
    appWindow.delayRestore();
    expect(await controller.toggle(appWindow)).toBe(true);
    expect(appWindow.calls).toEqual(["restore", "enter"]);
  });

  test("ordinary-window entry and later cycles do not inherit an earlier maximized state", async () => {
    const appWindow = nativeWindow(true);
    const controller = createNativeFullscreenController();
    await controller.toggle(appWindow);
    await controller.toggle(appWindow);
    await appWindow.unmaximize();
    appWindow.calls.length = 0;
    await controller.toggle(appWindow);
    await controller.toggle(appWindow);
    expect(await appWindow.isMaximized()).toBe(false);
    expect(appWindow.calls).toEqual(["enter", "exit"]);
  });

  test("a rejected entry restores maximization and still allows a later fullscreen cycle", async () => {
    const appWindow = nativeWindow(true);
    const controller = createNativeFullscreenController();
    appWindow.failNextEntry();
    await expect(controller.toggle(appWindow)).rejects.toThrow("Native fullscreen rejected");
    expect(await appWindow.isFullscreen()).toBe(false);
    expect(await appWindow.isMaximized()).toBe(true);
    expect(await controller.toggle(appWindow)).toBe(true);
    expect(await controller.toggle(appWindow)).toBe(false);
    expect(await appWindow.isMaximized()).toBe(true);
  });
});

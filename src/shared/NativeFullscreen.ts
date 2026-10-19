interface NativeFullscreenWindow {
  isFullscreen(): Promise<boolean>;
  isMaximized(): Promise<boolean>;
  setFullscreen(value: boolean): Promise<void>;
  maximize(): Promise<void>;
  unmaximize(): Promise<void>;
}

async function waitForState(read: () => Promise<boolean>, expected: boolean) {
  const deadline = Date.now() + 1500;
  while ((await read()) !== expected) {
    if (Date.now() >= deadline) throw new Error("Native window transition timed out");
    await new Promise<void>((resolve) => setTimeout(resolve, 16));
  }
}

/** Keeps fullscreen independent of the maximized work area and restores the prior state. */
export function createNativeFullscreenController() {
  let restoreMaximized = false;
  return {
    async toggle(appWindow: NativeFullscreenWindow): Promise<boolean> {
      if (await appWindow.isFullscreen()) {
        await appWindow.setFullscreen(false);
        await waitForState(() => appWindow.isFullscreen(), false);
        if (restoreMaximized) {
          await appWindow.maximize();
          await waitForState(() => appWindow.isMaximized(), true);
        }
        restoreMaximized = false;
        return false;
      }

      const wasMaximized = await appWindow.isMaximized();
      try {
        // Tao's Windows borderless frame clips maximized client bounds to rcWork,
        // including during fullscreen. Clear maximization before it saves placement.
        if (wasMaximized) {
          await appWindow.unmaximize();
          await waitForState(() => appWindow.isMaximized(), false);
        }
        await appWindow.setFullscreen(true);
        await waitForState(() => appWindow.isFullscreen(), true);
        restoreMaximized = wasMaximized;
        return true;
      } catch (error) {
        // A failed fullscreen request must not leave a previously maximized window restored.
        if (wasMaximized && !(await appWindow.isFullscreen())) {
          await appWindow.maximize();
          await waitForState(() => appWindow.isMaximized(), true);
        }
        throw error;
      }
    },
  };
}

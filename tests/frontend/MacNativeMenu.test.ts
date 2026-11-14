import { describe, expect, test } from "bun:test";
import {
  macMenuAccelerator,
  mountMacNativeMenu,
  usesMacNativeMenu,
  type MacMenuModel,
} from "../../src/platform/macos/NativeMenu";

type Options = {
  id?: string;
  text?: string;
  enabled?: boolean;
  checked?: boolean;
  accelerator?: string | null;
  action?: () => void;
  items?: FakeItem[];
  item?: string;
};

class FakeItem {
  closes = 0;
  windows = false;
  help = false;
  constructor(
    readonly kind: string,
    readonly options: Options
  ) {}
  async close() {
    this.closes++;
  }
  async setText(text: string) {
    this.options.text = text;
  }
  async setEnabled(enabled: boolean) {
    this.options.enabled = enabled;
  }
  async setChecked(checked: boolean) {
    this.options.checked = checked;
  }
  async setAccelerator(accelerator: string | null) {
    this.options.accelerator = accelerator;
  }
  async setAsWindowsMenuForNSApp() {
    this.windows = true;
  }
  async setAsHelpMenuForNSApp() {
    this.help = true;
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function menuApi() {
  const resources: FakeItem[] = [];
  const installs: FakeItem[] = [];
  const existing = new FakeItem("Menu", { id: "existing" });
  let current: FakeItem = existing;
  let beforeMenu: (() => Promise<void>) | undefined;
  let afterInstall: (() => Promise<void>) | undefined;
  let failSubmenu = false;
  const create = async (kind: string, options: Options = {}): Promise<FakeItem> => {
    if (kind === "Submenu" && failSubmenu) throw new Error("menu creation failed");
    const native = new FakeItem(kind, { ...options });
    resources.push(native);
    if (kind === "Menu") {
      Object.assign(native, {
        async setAsAppMenu() {
          const previous = current;
          current = native;
          installs.push(native);
          await afterInstall?.();
          // Tauri returns a separate resource handle for the previous menu.
          const wrapper = await create("Previous", previous.options);
          Object.assign(wrapper, {
            async setAsAppMenu() {
              const removed = current;
              current = previous;
              installs.push(previous);
              return create("Detached", removed.options);
            },
          });
          return wrapper;
        },
      });
      await beforeMenu?.();
    }
    return native;
  };
  const api = {
    Menu: {
      new: (options: Options) => create("Menu", options),
      default: () => create("Menu", { id: "default" }),
    },
    Submenu: { new: (options: Options) => create("Submenu", options) },
    MenuItem: { new: (options: Options) => create("MenuItem", options) },
    CheckMenuItem: { new: (options: Options) => create("CheckMenuItem", options) },
    PredefinedMenuItem: { new: (options: Options) => create("Predefined", options) },
  } as unknown as typeof import("@tauri-apps/api/menu");
  return {
    api,
    resources,
    installs,
    existing,
    find: (id: string) => resources.find(({ options }) => options.id === id)!,
    pauseMenu: (pause: () => Promise<void>) => {
      beforeMenu = pause;
    },
    pauseInstall: (pause: () => Promise<void>) => {
      afterInstall = pause;
    },
    failSubmenu: (fail: boolean) => {
      failSubmenu = fail;
    },
  };
}

function model(onSelect = () => {}): MacMenuModel {
  return {
    windowLabel: "Window",
    groups: [
      { id: "file", label: "File", entries: [{ id: "new", label: "New", onSelect }] },
      {
        id: "edit",
        label: "Edit",
        entries: [
          { id: "undo", label: "Undo", shortcut: "Cmd+Z", onSelect },
          { id: "settings-separator", separator: true },
          { id: "settings", label: "Settings", shortcut: "Cmd+,", onSelect },
        ],
      },
      {
        id: "view",
        label: "View",
        entries: [
          { id: "sidebar", label: "Sidebar", checked: false, shortcut: "Cmd+Shift+S", onSelect },
        ],
      },
      { id: "help", label: "Help", entries: [{ id: "about", label: "About BAAS", onSelect }] },
    ],
  };
}

describe("macOS native application menu", () => {
  test("the browser and Android retain their HTML menus", () => {
    expect(usesMacNativeMenu(true, false, "MacIntel")).toBe(true);
    expect(usesMacNativeMenu(false, false, "MacIntel")).toBe(false);
    expect(usesMacNativeMenu(true, true, "MacIntel")).toBe(false);
    expect(usesMacNativeMenu(true, false, "Linux aarch64")).toBe(false);
    expect(usesMacNativeMenu(true, false, "Win32")).toBe(false);
    expect(usesMacNativeMenu(true, false, "iPhone")).toBe(false);
  });

  test("native accelerators preserve remaps, arrows, plus, punctuation and disabled bindings", () => {
    expect(macMenuAccelerator("Cmd++")).toBe("Cmd+Equal");
    expect(macMenuAccelerator("Option+←")).toBe("Alt+ArrowLeft");
    expect(macMenuAccelerator("Cmd+,")).toBe("Cmd+,");
    expect(macMenuAccelerator("Cmd+Shift+?")).toBe("Cmd+Shift+Slash");
    expect(macMenuAccelerator("Cmd+!")).toBe("Cmd+Shift+Digit1");
    expect(macMenuAccelerator("Ctrl+Alt+U")).toBe("Ctrl+Alt+U");
    expect(macMenuAccelerator("F11")).toBe("F11");
    expect(macMenuAccelerator("Fn+Delete")).toBeNull();
    expect(macMenuAccelerator("")).toBeNull();
  });

  test("actions, translations, shortcuts and checks update without registering another menu", async () => {
    const fake = menuApi();
    let oldCalls = 0;
    let newCalls = 0;
    const session = mountMacNativeMenu(
      model(() => {
        oldCalls++;
      }),
      async () => fake.api
    );
    expect(await session.ready).toBe(true);
    const root = fake.find("baas-application-menu");
    expect(root.options.items?.map(({ options }) => options.text)).toEqual([
      "BAAS",
      "File",
      "Edit",
      "View",
      "Window",
      "Help",
    ]);
    expect(fake.find("baas-menu-window").windows).toBe(true);
    expect(fake.find("baas-menu-help").help).toBe(true);
    expect(
      fake
        .find("baas-menu-edit")
        .options.items?.some(({ options }) => options.id?.includes("settings"))
    ).toBe(false);
    fake.find("baas-edit-settings-app").options.action?.();
    expect(oldCalls).toBe(1);
    const next = model(() => {
      newCalls++;
    });
    next.windowLabel = "窗口";
    next.groups[0].label = "文件";
    next.groups[0].entries[0] = {
      id: "new",
      label: "创建",
      onSelect: () => {
        newCalls++;
      },
    };
    next.groups[1].entries[0] = {
      id: "undo",
      label: "Undo",
      shortcut: "Cmd+Alt+U",
      disabled: true,
      onSelect: () => {
        newCalls++;
      },
    };
    next.groups[2].entries[0] = {
      id: "sidebar",
      label: "Sidebar",
      checked: true,
      onSelect: () => {
        newCalls++;
      },
    };
    await session.update(next);
    expect(fake.find("baas-menu-file").options.text).toBe("文件");
    expect(fake.find("baas-menu-window").options.text).toBe("窗口");
    expect(fake.find("baas-file-new").options.text).toBe("创建");
    expect(fake.find("baas-edit-undo").options.accelerator).toBe("Cmd+Alt+U");
    expect(fake.find("baas-edit-undo").options.enabled).toBe(false);
    expect(fake.find("baas-view-sidebar").options.checked).toBe(true);
    fake.find("baas-edit-undo").options.action?.();
    fake.find("baas-file-new").options.action?.();
    expect(oldCalls).toBe(1);
    expect(newCalls).toBe(1);
    expect(fake.resources.filter(({ kind }) => kind === "Menu")).toHaveLength(1);
    // A failed/no-op action must undo the native check item's automatic toggle.
    fake.find("baas-view-sidebar").options.checked = false;
    fake.find("baas-view-sidebar").options.action?.();
    await session.update(next);
    expect(fake.find("baas-view-sidebar").options.checked).toBe(true);
    await session.dispose();
    expect(fake.installs.at(-1)).toBe(fake.existing);
    expect(fake.resources.every(({ closes }) => closes === 1)).toBe(true);
    const before = newCalls;
    fake.find("baas-file-new").options.action?.();
    expect(newCalls).toBe(before);
    await session.dispose();
    expect(fake.resources.every(({ closes }) => closes === 1)).toBe(true);
  });

  test("an unmount during creation releases partial resources before the next owner installs", async () => {
    const fake = menuApi();
    const started = deferred<void>();
    const release = deferred<void>();
    fake.pauseMenu(async () => {
      started.resolve();
      await release.promise;
    });
    const first = mountMacNativeMenu(model(), async () => fake.api);
    await started.promise;
    const cleanup = first.dispose();
    const next = mountMacNativeMenu(model(), async () => fake.api);
    fake.pauseMenu(async () => {});
    release.resolve();
    expect(await first.ready).toBe(false);
    await cleanup;
    expect(await next.ready).toBe(true);
    expect(fake.installs).toHaveLength(1);
    await next.dispose();
    expect(fake.resources.every(({ closes }) => closes === 1)).toBe(true);
  });

  test("a rejected creation cleans up and does not block a later installation", async () => {
    const fake = menuApi();
    fake.failSubmenu(true);
    const failed = mountMacNativeMenu(model(), async () => fake.api);
    await expect(failed.ready).rejects.toThrow("menu creation failed");
    await failed.dispose();
    expect(fake.resources.every(({ closes }) => closes === 1)).toBe(true);
    expect(fake.installs).toHaveLength(0);
    fake.failSubmenu(false);
    const recovered = mountMacNativeMenu(model(), async () => fake.api);
    expect(await recovered.ready).toBe(true);
    await recovered.dispose();
    expect(fake.resources.every(({ closes }) => closes === 1)).toBe(true);
  });

  test("cleanup during native installation restores the old menu before a replacement installs", async () => {
    const fake = menuApi();
    const started = deferred<void>();
    const release = deferred<void>();
    fake.pauseInstall(async () => {
      started.resolve();
      await release.promise;
    });
    const first = mountMacNativeMenu(model(), async () => fake.api);
    await started.promise;
    const cleanup = first.dispose();
    const replacement = mountMacNativeMenu(model(), async () => fake.api);
    fake.pauseInstall(async () => {});
    release.resolve();
    expect(await first.ready).toBe(false);
    await cleanup;
    expect(await replacement.ready).toBe(true);
    expect(fake.installs.map(({ options }) => options.id)).toEqual([
      "baas-application-menu",
      "existing",
      "baas-application-menu",
    ]);
    await replacement.dispose();
    expect(fake.installs.at(-1)).toBe(fake.existing);
    expect(fake.resources.every(({ closes }) => closes === 1)).toBe(true);
  });
});

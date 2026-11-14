import type {
  CheckMenuItem,
  Menu,
  MenuItem,
  PredefinedMenuItemOptions,
  Submenu,
} from "@tauri-apps/api/menu";
import type { TitlebarMenuEntry } from "@/components/layout/TitlebarMenu";
import { normalizeApplicationShortcut } from "@/shared/ApplicationShortcuts";

export interface MacMenuGroup {
  id: "file" | "edit" | "view" | "help";
  label: string;
  entries: TitlebarMenuEntry[];
}

export interface MacMenuModel {
  groups: MacMenuGroup[];
  windowLabel: string;
}

type MenuApi = typeof import("@tauri-apps/api/menu");
type Resource = { close(): Promise<void> };
type ActionItem = MenuItem | CheckMenuItem;
type ActionEntry = Exclude<TitlebarMenuEntry, { separator: true }>;

/** Muda uses physical key names; Fn is a hardware modifier, not an accelerator. */
export function macMenuAccelerator(shortcut?: string): string | null {
  const normalized = normalizeApplicationShortcut(shortcut ?? "", true);
  if (!normalized) return null;
  if (normalized === "+") return "Equal";
  if (normalized.endsWith("++")) return normalized.slice(0, -1) + "Equal";
  const parts = normalized.split("+");
  const key = parts.pop()!;
  const shifted: Record<string, string> = {
    "~": "Backquote",
    "!": "Digit1",
    "@": "Digit2",
    "#": "Digit3",
    "$": "Digit4",
    "%": "Digit5",
    "^": "Digit6",
    "&": "Digit7",
    "*": "Digit8",
    "(": "Digit9",
    ")": "Digit0",
    "_": "Minus",
    "{": "BracketLeft",
    "}": "BracketRight",
    "|": "Backslash",
    ":": "Semicolon",
    '"': "Quote",
    "<": "Comma",
    ">": "Period",
    "?": "Slash",
  };
  if (shifted[key] && !parts.includes("Shift")) parts.push("Shift");
  return [...parts, shifted[key] ?? key].join("+");
}

export function usesMacNativeMenu(tauri: boolean, android: boolean, platform: string): boolean {
  return tauri && !android && /^Mac/.test(platform);
}

// Serialize installation and restoration, including React's setup/cleanup/setup cycle.
let nativeMenuQueue: Promise<unknown> = Promise.resolve();
function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = nativeMenuQueue.then(operation);
  nativeMenuQueue = result.catch(() => undefined);
  return result;
}

/** One mounted titlebar owns the application menu and all native resources it creates. */
export function mountMacNativeMenu(
  initial: MacMenuModel,
  loadApi: () => Promise<MenuApi> = () => import("@tauri-apps/api/menu")
) {
  let model = initial;
  let active = true;
  let installed = false;
  let menu: Menu | undefined;
  let previous: Menu | null = null;
  let api: MenuApi;
  const resources: Resource[] = [];
  const labels: { native: Submenu; read: () => string; value: string }[] = [];
  const actions: {
    native: ActionItem;
    read: () => ActionEntry | undefined;
    value: string;
  }[] = [];

  const remember = <T extends Resource>(resource: T): T => {
    resources.push(resource);
    return resource;
  };
  const entry = (groupId: string, itemId: string): ActionEntry | undefined => {
    const value = model.groups
      .find(({ id }) => id === groupId)
      ?.entries.find(({ id }) => id === itemId);
    return value && !("separator" in value) ? value : undefined;
  };
  const metadata = (value?: ActionEntry) => ({
    text: value?.label ?? "",
    enabled: Boolean(value && !value.disabled),
    accelerator: macMenuAccelerator(value?.shortcut),
    checked: value?.checked,
  });
  const action = async (groupId: string, itemId: string, suffix = "") => {
    const read = () => entry(groupId, itemId);
    const value = metadata(read());
    const options = {
      id: `baas-${groupId}-${itemId}${suffix}`,
      text: value.text,
      enabled: value.enabled,
      accelerator: value.accelerator ?? undefined,
      action: () => {
        const current = read();
        if (active && current && !current.disabled) current.onSelect();
        if (current?.checked !== undefined) {
          void enqueue(async () => {
            if (active && installed)
              await (native as CheckMenuItem).setChecked(Boolean(read()?.checked));
          }).catch((error: unknown) => console.warn("[mac-menu] check state failed", error));
        }
      },
    };
    const native = remember(
      value.checked === undefined
        ? await api.MenuItem.new(options)
        : await api.CheckMenuItem.new({ ...options, checked: value.checked })
    );
    actions.push({ native, read, value: JSON.stringify(value) });
    return native;
  };
  const predefined = async (item: PredefinedMenuItemOptions["item"]) =>
    remember(await api.PredefinedMenuItem.new({ item }));
  const submenu = async (
    id: string,
    read: () => string,
    items: Parameters<MenuApi["Submenu"]["new"]>[0]["items"]
  ) => {
    const value = read();
    const native = remember(await api.Submenu.new({ id: `baas-menu-${id}`, text: value, items }));
    labels.push({ native, read, value });
    return native;
  };
  const closeResources = async () => {
    const results = await Promise.allSettled(
      resources
        .splice(0)
        .reverse()
        .map((resource) => resource.close())
    );
    for (const result of results)
      if (result.status === "rejected")
        console.warn("[mac-menu] resource cleanup failed", result.reason);
  };
  const restore = async () => {
    if (!installed) return;
    const fallback = previous ?? remember(await api.Menu.default());
    const detached = await fallback.setAsAppMenu();
    if (detached) remember(detached);
    if (previous) remember(previous);
    installed = false;
  };
  const synchronize = async () => {
    for (const label of labels) {
      const value = label.read();
      if (label.value === value) continue;
      await label.native.setText(value);
      label.value = value;
    }
    for (const item of actions) {
      const value = metadata(item.read());
      const serialized = JSON.stringify(value);
      if (serialized === item.value) continue;
      const old = JSON.parse(item.value) as ReturnType<typeof metadata>;
      if (old.text !== value.text) await item.native.setText(value.text);
      if (old.enabled !== value.enabled) await item.native.setEnabled(value.enabled);
      if (old.accelerator !== value.accelerator)
        await item.native.setAccelerator(value.accelerator);
      if (value.checked !== undefined)
        await (item.native as CheckMenuItem).setChecked(value.checked);
      item.value = serialized;
    }
  };

  const ready = enqueue(async () => {
    if (!active) return false;
    try {
      api = await loadApi();
      if (!active) return false;
      const appItems = [];
      if (entry("help", "about")) appItems.push(await action("help", "about", "-app"));
      appItems.push(await predefined("Separator"));
      if (entry("edit", "settings")) appItems.push(await action("edit", "settings", "-app"));
      appItems.push(
        await predefined("Separator"),
        await predefined("Services"),
        await predefined("Separator")
      );
      appItems.push(
        await predefined("Hide"),
        await predefined("HideOthers"),
        await predefined("ShowAll")
      );
      appItems.push(await predefined("Separator"), await predefined("Quit"));
      const app = await submenu("app", () => "BAAS", appItems);
      const groups = new Map<string, Submenu>();
      for (const group of model.groups) {
        const items = [];
        // Settings belongs to the application menu on macOS.
        const entries = group.entries.filter(
          (value) => value.id !== "settings" && value.id !== "settings-separator"
        );
        for (const value of entries) {
          items.push(
            "separator" in value ? await predefined("Separator") : await action(group.id, value.id)
          );
        }
        if (group.id === "file")
          items.push(await predefined("Separator"), await predefined("CloseWindow"));
        groups.set(
          group.id,
          await submenu(
            group.id,
            () => model.groups.find(({ id }) => id === group.id)?.label ?? group.label,
            items
          )
        );
      }
      const windows = await submenu("window", () => model.windowLabel, [
        await predefined("Minimize"),
        await predefined("Maximize"),
        await predefined("Separator"),
        await predefined("BringAllToFront"),
      ]);
      menu = remember(
        await api.Menu.new({
          id: "baas-application-menu",
          items: [
            app,
            groups.get("file")!,
            groups.get("edit")!,
            groups.get("view")!,
            windows,
            groups.get("help")!,
          ],
        })
      );
      if (!active) {
        await closeResources();
        return false;
      }
      previous = await menu.setAsAppMenu();
      installed = true;
      await windows.setAsWindowsMenuForNSApp();
      await groups.get("help")!.setAsHelpMenuForNSApp();
      await synchronize();
      return active;
    } catch (error) {
      try {
        await restore();
      } finally {
        await closeResources();
      }
      throw error;
    }
  });

  return {
    ready,
    update(next: MacMenuModel) {
      model = next;
      return enqueue(async () => {
        if (active && installed) await synchronize();
      });
    },
    dispose() {
      active = false;
      return enqueue(async () => {
        try {
          await restore();
        } finally {
          await closeResources();
        }
      });
    },
  };
}

import { describe, expect, test } from "bun:test";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { renderToStaticMarkup } from "react-dom/server";
import HomeLayoutEditor from "../../src/components/plugins/HomeLayoutEditor";
import {
  homeSectionPresentation,
  loadPluginHomeData,
  type HomePluginRequest,
} from "../../src/shared/PluginHomeLayout";
import { homeLayout, moveHomeSection } from "../../src/shared/PluginTools";
import type { PluginCatalog, PluginDescriptor, PluginSettings } from "../../src/shared/Plugins";

const editor: PluginDescriptor = {
  schema_version: 1,
  api_version: 1,
  id: "baas.home-editor",
  version: "1.0.0",
  name: "Home editor",
  permissions: [],
  settings_schema: { type: "object", properties: {} },
  actions: [],
  source: "builtin",
  enabled: true,
  trusted: true,
  state: "available",
};
const catalog = (plugin = editor): PluginCatalog => ({
  api_version: 1,
  capabilities: [],
  plugins: [plugin],
  errors: [],
});
const settings = (configId = "one"): PluginSettings => ({
  config_id: configId,
  plugin_id: editor.id,
  revision: 2,
  values: { assets_visible: false, section_order: ["logs", "tasks", "assets", "shortcuts"] },
});

describe("profile-scoped home layout", () => {
  test("an unsupported catalog version cannot apply layouts or launchers", async () => {
    const commands: string[] = [];
    const request: HomePluginRequest = async <T,>(command: string) => {
      commands.push(command);
      return { ...catalog(), api_version: 2 } as T;
    };
    expect(await loadPluginHomeData(request, "one", () => true)).toEqual({
      cards: [],
      layout: null,
    });
    expect(commands).toEqual(["get_plugin_catalog"]);
  });

  test("disabled, untrusted, external and unavailable packages cannot override the home layout", async () => {
    for (const plugin of [
      { ...editor, enabled: false },
      { ...editor, trusted: false },
      { ...editor, source: "external" as const },
      { ...editor, state: "error" as const },
      { ...editor, state: "incompatible" as const },
    ]) {
      const commands: string[] = [];
      const request: HomePluginRequest = async <T,>(command: string) => {
        commands.push(command);
        return catalog(plugin) as T;
      };
      expect(await loadPluginHomeData(request, "one", () => true)).toEqual({
        cards: [],
        layout: null,
      });
      expect(commands).toEqual(["get_plugin_catalog"]);
    }
  });

  test("loads settings from the owning profile only, with a normalized complete order", async () => {
    const requests: unknown[] = [];
    const request: HomePluginRequest = async <T,>(command: string, configId, payload) => {
      requests.push({ command, configId, payload });
      return (command === "get_plugin_catalog" ? catalog() : settings(configId)) as T;
    };
    const result = await loadPluginHomeData(request, "two", () => true);
    expect(result?.layout?.assets_visible).toBe(false);
    expect(result?.layout?.section_order).toEqual(["logs", "tasks", "assets", "shortcuts"]);
    expect(requests).toEqual([
      { command: "get_plugin_catalog", configId: "two", payload: undefined },
      { command: "get_plugin_settings", configId: "two", payload: { plugin_id: editor.id } },
    ]);
  });

  test("discarded catalog responses cannot issue a settings request after a profile/session switch", async () => {
    let resolveCatalog!: (value: PluginCatalog) => void;
    let current = true;
    const commands: string[] = [];
    const request: HomePluginRequest = <T,>(command: string) => {
      commands.push(command);
      return new Promise<PluginCatalog>((resolve) => {
        resolveCatalog = resolve;
      }) as Promise<T>;
    };
    const loading = loadPluginHomeData(request, "one", () => current);
    current = false;
    resolveCatalog(catalog());
    expect(await loading).toBeNull();
    expect(commands).toEqual(["get_plugin_catalog"]);
  });

  test("late settings replies cannot replace a newer profile/session generation", async () => {
    let resolveSettings!: (value: PluginSettings) => void;
    let current = true;
    const request: HomePluginRequest = async <T,>(command: string) => {
      if (command === "get_plugin_catalog") return catalog() as T;
      return new Promise<PluginSettings>((resolve) => {
        resolveSettings = resolve;
      }) as Promise<T>;
    };
    const loading = loadPluginHomeData(request, "one", () => current);
    await Promise.resolve();
    current = false;
    resolveSettings(settings());
    expect(await loading).toBeNull();
  });

  test("mismatched settings and unavailable legacy settings retain the standard layout", async () => {
    for (const reply of [settings("other"), { ...settings(), plugin_id: "another.plugin" }, null]) {
      const request: HomePluginRequest = async <T,>(command: string) => {
        if (command === "get_plugin_catalog") return catalog() as T;
        if (reply === null) throw new Error("Unknown command");
        return reply as T;
      };
      expect((await loadPluginHomeData(request, "one", () => true))?.layout).toBeNull();
    }
  });

  test("legacy Android ordering and the global assets preference survive disabled plugins", () => {
    const desktop = homeSectionPresentation(null, false, false);
    expect(desktop.order).toEqual(["shortcuts", "assets", "tasks", "logs"]);
    expect(desktop.visible).toEqual({ shortcuts: true, assets: false, tasks: true, logs: true });
    expect(desktop.edit).toBe(false);
    expect(homeSectionPresentation(null, true, true).order).toEqual([
      "shortcuts",
      "tasks",
      "assets",
      "logs",
    ]);
  });

  test("enabled layout can override assets independently while logs always remain visible", () => {
    const layout = homeLayout({
      assets_visible: true,
      tasks_visible: false,
      shortcuts_visible: false,
    });
    const presentation = homeSectionPresentation(layout, false, true);
    expect(presentation.visible).toEqual({
      shortcuts: false,
      assets: true,
      tasks: false,
      logs: true,
    });
    expect(presentation.edit).toBe(true);
    expect(homeSectionPresentation({ ...layout, show_edit_entry: false }, true, false).edit).toBe(
      false
    );
  });

  test("imported duplicates and missing sections normalize without mutating saved settings", () => {
    const imported = { section_order: ["logs", "logs", "unknown", "tasks"] };
    const layout = homeLayout(imported);
    expect(layout.section_order).toEqual(["logs", "tasks", "shortcuts", "assets"]);
    expect(moveHomeSection(layout.section_order, 0, 3)).toEqual([
      "tasks",
      "shortcuts",
      "assets",
      "logs",
    ]);
    expect(layout.section_order).toEqual(["logs", "tasks", "shortcuts", "assets"]);
    expect(imported.section_order).toEqual(["logs", "logs", "unknown", "tasks"]);
    expect(moveHomeSection(layout.section_order, -1, 2)).toEqual(layout.section_order);
  });
});

test("home editor renders bounded ordinary controls, accessible reorder buttons and fixed log visibility", async () => {
  const translator = createInstance();
  await translator.init({
    lng: "en",
    resources: {
      en: {
        translation: {
          plugins: {
            homeEditor: {
              title: "Home layout",
              description: "Layout settings",
              orderHint: "Drag or use arrows",
              shortcuts: "Shortcuts",
              assets: "Assets",
              tasks: "Tasks",
              logs: "Logs",
              moveUp: "Move {{section}} up",
              moveDown: "Move {{section}} down",
              showSection: "Show {{section}}",
              logsAlwaysVisible: "Logs remain visible.",
              showEditEntry: "Show edit entry",
            },
          },
        },
      },
    },
  });
  const markup = renderToStaticMarkup(
    <I18nextProvider i18n={translator}>
      <HomeLayoutEditor
        value={{ section_order: ["logs", "assets", "tasks", "shortcuts"] }}
        onChange={() => {}}
        disabled
      />
    </I18nextProvider>
  );
  expect(markup).toContain('<fieldset disabled=""');
  expect(markup.match(/role="switch"/g)).toHaveLength(4);
  expect(markup.match(/data-home-layout-section=/g)).toHaveLength(4);
  expect(markup).toContain('aria-label="Move Logs up"');
  expect(markup).toContain('aria-label="Move Shortcuts down"');
  expect(markup).toContain("Logs remain visible.");
  expect(markup).not.toContain('role="switch" aria-label="Show Logs"');
  expect(markup).not.toContain("<textarea");
});

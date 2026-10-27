import { describe, expect, test } from "bun:test";
import { collectPluginHomeCards } from "../../src/shared/PluginHome";
import type { PluginCatalog, PluginDescriptor } from "../../src/shared/Plugins";

const plugin: PluginDescriptor = {
  schema_version: 1,
  api_version: 1,
  id: "example.notes",
  version: "1.0.0",
  name: { en: "Notes", zh: "笔记" },
  description: "Notes",
  permissions: ["compute"],
  settings_schema: { type: "object", properties: {}, additionalProperties: false },
  actions: [
    { id: "format", name: "Format", execution: "compute", input_schema: { type: "object" } },
  ],
  source: "external",
  enabled: true,
  trusted: true,
  state: "available",
  contributions: { home: [{ id: "format-note", title: "Format note", action_id: "format" }] },
};
const catalog = (...plugins: PluginDescriptor[]): PluginCatalog => ({
  api_version: 1,
  capabilities: ["home.cards"],
  plugins,
  errors: [],
});

describe("declarative plugin home contributions", () => {
  test("disabled, untrusted, broken and undeclared actions cannot become home controls", () => {
    expect(
      collectPluginHomeCards(
        catalog(
          { ...plugin, enabled: false },
          { ...plugin, trusted: false },
          { ...plugin, state: "error" },
          { ...plugin, actions: [] }
        )
      )
    ).toEqual([]);
  });
  test("keeps localized metadata and opens only the owning plugin", () => {
    expect(collectPluginHomeCards(catalog(plugin))).toEqual([
      {
        key: "example.notes:format-note",
        pluginId: "example.notes",
        pluginName: plugin.name,
        title: "Format note",
        description: undefined,
      },
    ]);
  });
  test("keeps home compact when packages declare many actions", () => {
    const plugins = Array.from({ length: 30 }, (_, index) => ({
      ...plugin,
      id: `example.notes-${index}`,
    }));
    const cards = collectPluginHomeCards(catalog(...plugins));
    expect(cards).toHaveLength(6);
    expect(new Set(cards.map((card) => card.key)).size).toBe(6);
  });
});

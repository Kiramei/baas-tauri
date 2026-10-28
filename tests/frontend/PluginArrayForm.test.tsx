import { describe, expect, test } from "bun:test";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { renderToStaticMarkup } from "react-dom/server";
import PluginSchemaForm, {
  pluginArrayEntryDefault,
} from "../../src/components/plugins/PluginSchemaForm";
import { validatePluginValue, type PluginSchema } from "../../src/shared/Plugins";

async function render(
  schema: PluginSchema,
  value: Parameters<typeof PluginSchemaForm>[0]["value"]
) {
  const translator = createInstance();
  await translator.init({
    lng: "en",
    resources: {
      en: {
        translation: {
          common: { delete: "Delete", choose: "Choose" },
          plugins: {
            addEntry: "Add entry",
            removeEntry: "Remove entry {{index}}",
            entryLabel: "Entry {{index}}",
            emptyArray: "No entries yet.",
            arrayLimit: "{{count}} / {{maximum}} entries",
            values: "Values",
          },
        },
      },
    },
  });
  return renderToStaticMarkup(
    <I18nextProvider i18n={translator}>
      <PluginSchemaForm schema={schema} value={value} onChange={() => {}} onInvalid={() => {}} />
    </I18nextProvider>
  );
}

describe("repeatable host-owned plugin forms", () => {
  test("equipment object rows render ordinary fields and enum choices, never a raw JSON editor", async () => {
    const markup = await render(
      {
        type: "array",
        title: "Equipment targets",
        description: "Your equipment needs",
        minItems: 1,
        maxItems: 2,
        items: {
          type: "object",
          properties: {
            slot: { type: "string", title: "Slot", enum: ["hat", "bag"] },
            quantity: { type: "integer", title: "Target quantity", minimum: 1, maximum: 99 },
            note: { type: "string", title: "Note" },
          },
          required: ["slot", "quantity"],
        },
      },
      [{ slot: "hat", quantity: 3, note: "<script>bad()</script>" }]
    );
    expect(markup).toContain("Equipment targets");
    expect(markup).toContain("Your equipment needs");
    expect(markup).toContain("<select");
    expect(markup).toContain('type="number"');
    expect(markup).toContain('min="1"');
    expect(markup).toContain("1 / 2 entries");
    expect(markup).toMatch(/disabled="" aria-label="Remove entry 1"/);
    expect(markup).toContain("&lt;script&gt;bad()&lt;/script&gt;");
    expect(markup).not.toContain("<textarea");
    expect(markup).not.toContain("<script>");
  });

  test("nested team plans and scalar rows render recursively with accessible actions", async () => {
    const markup = await render(
      {
        type: "array",
        title: "Team plan",
        maxItems: 2,
        items: {
          type: "array",
          title: "Team order",
          minItems: 1,
          maxItems: 3,
          items: { type: "integer", title: "Team number", minimum: 1, maximum: 4 },
        },
      },
      [[1, 2], [3]]
    );
    expect(markup).toContain("Team plan");
    expect(markup).toContain("Team order");
    expect(markup.match(/type="number"/g)).toHaveLength(3);
    expect(markup.match(/>Add entry</g)).toHaveLength(3);
    expect(markup).toContain('aria-label="Remove entry 2"');
    expect(markup).toContain("2 / 2 entries");
    expect(markup).not.toContain("<textarea");
  });

  test("empty lists have a localized state and a single ordinary add action", async () => {
    const markup = await render(
      { type: "array", title: "Mail entries", maxItems: 5, items: { type: "string" } },
      []
    );
    expect(markup).toContain("No entries yet.");
    expect(markup).toContain("0 / 5 entries");
    expect(markup.match(/>Add entry</g)).toHaveLength(1);
    expect(markup).not.toContain("Remove entry");
  });

  test("added records preserve declared defaults and initialize required nested minimum rows", () => {
    const schema: PluginSchema = {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["hat", "bag"] },
        count: { type: "integer", minimum: 2 },
        enabled: { type: "boolean", default: true },
        tags: {
          type: "array",
          minItems: 2,
          maxItems: 3,
          items: { type: "string", default: "new" },
        },
        optional: { type: "string" },
      },
      required: ["kind", "count", "tags"],
    };
    const value = pluginArrayEntryDefault(schema);
    expect(value).toEqual({ kind: "hat", count: 2, enabled: true, tags: ["new", "new"] });
    expect(validatePluginValue(schema, value)).toEqual([]);
    expect(value).not.toHaveProperty("optional");
  });

  test("explicit array defaults are cloned per added record without sharing mutable arrays", () => {
    const schema: PluginSchema = {
      type: "array",
      items: { type: "object", properties: { count: { type: "number" } } },
      default: [{ count: 4 }],
    };
    const first = pluginArrayEntryDefault(schema) as { count: number }[];
    const second = pluginArrayEntryDefault(schema) as { count: number }[];
    first[0].count = 99;
    expect(second).toEqual([{ count: 4 }]);
    expect(schema.default).toEqual([{ count: 4 }]);
  });
});

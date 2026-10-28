import { describe, expect, test } from "bun:test";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { InventoryToolForm, InventoryToolResult } from "../../src/components/plugins/InventoryTool";
import {
  editInventoryCell,
  inventoryDraft,
  placementCells,
  type InventoryDraft,
} from "../../src/shared/PluginTools";
import type { JsonValue } from "../../src/shared/Plugins";

const blank = (): InventoryDraft => ({
  items: [
    { width: 3, height: 2, count: 1 },
    { width: 1, height: 1, count: 2 },
    { width: 1, height: 2, count: 0 },
  ],
  empty_cells: [],
  placed: [],
});

async function renderResult(value: JsonValue) {
  const translator = createInstance();
  await translator.init({
    lng: "en",
    resources: {
      en: {
        translation: {
          pluginTools: {
            inventory: {
              solved: "{{arrangements}} exact arrangements",
              limit: "Exact calculation exceeded its resource budget.",
              impossible: "No compatible arrangement.",
              best: "Highlighted cells are the best next choices.",
            },
          },
        },
      },
    },
  });
  return renderToStaticMarkup(
    <I18nextProvider i18n={translator}>
      <InventoryToolResult value={value} />
    </I18nextProvider>
  );
}

const cells = () =>
  Array.from({ length: 45 }, (_, index) => ({
    row: Math.floor(index / 9),
    col: index % 9,
    group_a: 0.2,
    group_b: 0.1,
    group_c: 0,
    any_item: 0.3,
    revealed: index === 0,
  }));

describe("inventory board editing", () => {
  test("rectangles use row-major cell IDs and rotation swaps both dimensions", () => {
    const item = blank().items[0];
    const origin = { item_index: 0, row: 1, col: 2, rotated: false };
    expect(placementCells(item, origin)).toEqual([11, 12, 13, 20, 21, 22]);
    expect(placementCells(item, { ...origin, rotated: true })).toEqual([11, 12, 20, 21, 29, 30]);
  });

  test("right and bottom boundaries are checked after rotation", () => {
    const item = blank().items[0];
    expect(placementCells(item, { item_index: 0, row: 3, col: 6, rotated: false })).toEqual([
      33, 34, 35, 42, 43, 44,
    ]);
    expect(placementCells(item, { item_index: 0, row: 3, col: 7, rotated: false })).toEqual([]);
    expect(placementCells(item, { item_index: 0, row: 3, col: 6, rotated: true })).toEqual([]);
    expect(placementCells(item, { item_index: 0, row: -1, col: 0, rotated: false })).toEqual([]);
    expect(placementCells(item, { item_index: 0, row: 0, col: -1, rotated: false })).toEqual([]);
  });

  test("fractional or nonfinite placement coordinates are never valid cells", () => {
    const item = blank().items[0];
    for (const value of [0.5, NaN, Infinity, -Infinity]) {
      expect(placementCells(item, { item_index: 0, row: value, col: 0, rotated: false })).toEqual(
        []
      );
      expect(placementCells(item, { item_index: 0, row: 0, col: value, rotated: false })).toEqual(
        []
      );
    }
  });

  test("placements remain disjoint from both known empty cells and other item groups", () => {
    const draft = blank();
    draft.empty_cells = [1];
    expect(editInventoryCell(draft, 0, 0)).toBeNull();
    const first = editInventoryCell(draft, 9, 0)!;
    expect(first.placed).toEqual([{ item_index: 0, row: 1, col: 0, rotated: false }]);
    expect(editInventoryCell(first, 10, 1)).toBeNull();
    expect(editInventoryCell(first, 8, 1)?.placed).toHaveLength(2);
    expect(draft.placed).toEqual([]);
  });

  test("found items consume the declared group total, including zero-count disabled groups", () => {
    const draft = blank();
    expect(editInventoryCell(draft, 0, 2)).toBeNull();
    const first = editInventoryCell(draft, 0, 0)!;
    expect(editInventoryCell(first, 27, 0)).toBeNull();
    const one = editInventoryCell(draft, 0, 1)!;
    const two = editInventoryCell(one, 1, 1)!;
    expect(two.placed).toHaveLength(2);
    expect(editInventoryCell(two, 2, 1)).toBeNull();
  });

  test("clicking any covered cell clears its whole found item and restores its count", () => {
    const first = editInventoryCell(blank(), 10, 0)!;
    const cleared = editInventoryCell(first, 21, "clear")!;
    expect(cleared.placed).toEqual([]);
    expect(editInventoryCell(cleared, 0, 0)?.placed).toHaveLength(1);
    expect(first.placed).toHaveLength(1);
    const empty = editInventoryCell(first, 21, "empty")!;
    expect(empty.placed).toEqual([]);
    expect(empty.empty_cells).toEqual([21]);
  });

  test("known empty cells toggle without duplicates; clear changes only the selected observation", () => {
    const empty = editInventoryCell(blank(), 2, "empty")!;
    expect(empty.empty_cells).toEqual([2]);
    expect(editInventoryCell(empty, 2, "empty")?.empty_cells).toEqual([]);
    const second = editInventoryCell(empty, 3, "empty")!;
    expect(editInventoryCell(second, 2, "clear")?.empty_cells).toEqual([3]);
    for (const index of [-1, 45, 1.5, NaN, Infinity])
      expect(editInventoryCell(second, index, "empty")).toBeNull();
  });

  test("received JSON is read into a draft without mutating saved inputs", () => {
    const value: JsonValue = {
      items: [{ width: 2, height: 1, count: 1 }],
      empty_cells: [44],
      placed: [{ item_index: 0, row: 0, col: 0, rotated: false }],
    };
    const draft = inventoryDraft(value);
    draft.empty_cells.push(43);
    draft.items[0].width = 4;
    draft.placed[0].row = 1;
    expect(value).toEqual({
      items: [{ width: 2, height: 1, count: 1 }],
      empty_cells: [44],
      placed: [{ item_index: 0, row: 0, col: 0, rotated: false }],
    });
  });
});

describe("inventory result presentation", () => {
  test("exact arrangement counts retain string precision and revealed cells hide their percentages", async () => {
    const markup = await renderResult({
      status: "solved",
      total_arrangements: "10000000000000000001",
      cells: cells(),
      best_cells: [22],
    });
    expect(markup).toContain("10000000000000000001 exact arrangements");
    expect(markup).toContain("A: 20.0% · B: 10.0% · C: 0.0%");
    expect(markup.match(/>30%</g)).toHaveLength(44);
    expect(markup).toContain("ring-1 ring-primary");
    expect(markup).toContain("Highlighted cells are the best next choices.");
  });

  test.each(["limit", "impossible"])(
    "%s results never display leftover or malformed probability grids",
    async (status) => {
      const markup = await renderResult({
        status,
        total_arrangements: "0",
        cells: cells(),
        best_cells: [22],
      });
      expect(markup).toContain(
        status === "limit" ? "resource budget" : "No compatible arrangement"
      );
      expect(markup).not.toContain("30%");
      expect(markup).not.toContain("Highlighted cells");
      expect(markup).not.toContain("ring-1 ring-primary");
    }
  );

  test("board form provides 45 labelled host buttons and keeps JSON out of the interaction", async () => {
    const translator = createInstance();
    await translator.init({
      lng: "en",
      resources: {
        en: {
          translation: {
            pluginTools: {
              inventory: { cell: "Row {{row}}, column {{col}}", board: "Inventory board" },
            },
          },
        },
      },
    });
    const markup = renderToStaticMarkup(
      <I18nextProvider i18n={translator}>
        <InventoryToolForm
          schema={{
            type: "object",
            properties: {
              items: {
                type: "array",
                minItems: 3,
                maxItems: 3,
                items: {
                  type: "object",
                  properties: {
                    width: { type: "integer" },
                    height: { type: "integer" },
                    count: { type: "integer" },
                  },
                },
              },
            },
          }}
          value={blank() as unknown as JsonValue}
          onChange={() => {}}
          onInvalid={() => {}}
          disabled
        />
      </I18nextProvider>
    );
    expect(markup.match(/aria-label="Row \d, column \d"/g)).toHaveLength(45);
    expect(markup).toContain('aria-label="Inventory board"');
    expect(markup).not.toContain("<textarea");
    expect(markup).toContain('disabled=""');
  });
});

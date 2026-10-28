import type { JsonValue, PluginAction, PluginDescriptor } from "./Plugins";

export type HomeSection = "shortcuts" | "assets" | "tasks" | "logs";
export const HOME_SECTIONS: HomeSection[] = ["shortcuts", "assets", "tasks", "logs"];
export interface HomeLayout {
  assets_visible: boolean;
  tasks_visible: boolean;
  shortcuts_visible: boolean;
  show_edit_entry: boolean;
  section_order: HomeSection[];
}
export const DEFAULT_HOME_LAYOUT: HomeLayout = {
  assets_visible: true,
  tasks_visible: true,
  shortcuts_visible: true,
  show_edit_entry: true,
  section_order: HOME_SECTIONS,
};
export function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
/** Imported settings and older clients may omit sections; always keep a complete order. */
export function homeLayout(value: JsonValue | undefined): HomeLayout {
  const input = jsonRecord(value);
  const section_order = [
    ...new Set([
      ...(Array.isArray(input.section_order) ? input.section_order : []),
      ...HOME_SECTIONS,
    ]),
  ].filter((id): id is HomeSection => HOME_SECTIONS.includes(id as HomeSection));
  return {
    assets_visible: input.assets_visible !== false,
    tasks_visible: input.tasks_visible !== false,
    shortcuts_visible: input.shortcuts_visible !== false,
    show_edit_entry: input.show_edit_entry !== false,
    section_order,
  };
}
export function moveHomeSection(
  order: readonly HomeSection[],
  from: number,
  to: number
): HomeSection[] {
  const result = [...order];
  if (from < 0 || to < 0 || from >= result.length || to >= result.length) return result;
  result.splice(to, 0, result.splice(from, 1)[0]);
  return result;
}
export const isBuiltinTool = (plugin: PluginDescriptor, id: string): boolean =>
  plugin.source === "builtin" && plugin.id === id;
export const isDeviceAction = (action: PluginAction): boolean =>
  action.execution === "device_task" ||
  (action.execution === "host_automation" && action.id !== "plan");

export function dateTimeInput(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
/** The browser shows local time, while the backend receives an unambiguous instant. */
export function dateTimeIso(value: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && dateTimeInput(date.toISOString()) === value
    ? date.toISOString()
    : undefined;
}

export interface InventoryItem {
  width: number;
  height: number;
  count: number;
}
export interface InventoryPlacement {
  item_index: number;
  row: number;
  col: number;
  rotated: boolean;
}
export interface InventoryDraft {
  items: InventoryItem[];
  empty_cells: number[];
  placed: InventoryPlacement[];
}
export function inventoryDraft(value: JsonValue): InventoryDraft {
  const input = jsonRecord(value);
  return {
    items: (Array.isArray(input.items) ? input.items : []).map((entry) => {
      const item = jsonRecord(entry);
      return { width: Number(item.width), height: Number(item.height), count: Number(item.count) };
    }),
    empty_cells: Array.isArray(input.empty_cells) ? input.empty_cells.map(Number) : [],
    placed: Array.isArray(input.placed)
      ? input.placed.map((entry) => {
          const placed = jsonRecord(entry);
          return {
            item_index: Number(placed.item_index),
            row: Number(placed.row),
            col: Number(placed.col),
            rotated: placed.rotated === true,
          };
        })
      : [],
  };
}
export function placementCells(
  item: InventoryItem | undefined,
  placed: InventoryPlacement
): number[] {
  if (!item) return [];
  const width = placed.rotated ? item.height : item.width;
  const height = placed.rotated ? item.width : item.height;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    !Number.isInteger(placed.row) ||
    !Number.isInteger(placed.col) ||
    width < 1 ||
    height < 1 ||
    width > 4 ||
    height > 4 ||
    placed.row < 0 ||
    placed.col < 0 ||
    placed.row + height > 5 ||
    placed.col + width > 9
  )
    return [];
  return Array.from({ length: height }, (_, row) =>
    Array.from({ length: width }, (_, col) => (placed.row + row) * 9 + placed.col + col)
  ).flat();
}
/** Found rectangles must fit, remain disjoint, and count toward the declared total. */
export function editInventoryCell(
  draft: InventoryDraft,
  index: number,
  mode: "empty" | "clear" | number,
  rotated = false
): InventoryDraft | null {
  if (!Number.isInteger(index) || index < 0 || index > 44) return null;
  const hit = draft.placed.findIndex((piece) =>
    placementCells(draft.items[piece.item_index], piece).includes(index)
  );
  if (mode === "clear" || mode === "empty") {
    const placed = draft.placed.filter((_, position) => position !== hit);
    const empty_cells = draft.empty_cells.filter((cell) => cell !== index);
    if (mode === "empty" && !draft.empty_cells.includes(index)) empty_cells.push(index);
    return { ...draft, placed, empty_cells };
  }
  const item = draft.items[mode];
  const piece = { item_index: mode, row: Math.floor(index / 9), col: index % 9, rotated };
  const cells = placementCells(item, piece);
  if (
    !cells.length ||
    draft.placed.filter((entry) => entry.item_index === mode).length >= item.count ||
    cells.some(
      (cell) =>
        draft.empty_cells.includes(cell) ||
        draft.placed.some((entry) =>
          placementCells(draft.items[entry.item_index], entry).includes(cell)
        )
    )
  )
    return null;
  return { ...draft, placed: [...draft.placed, piece] };
}

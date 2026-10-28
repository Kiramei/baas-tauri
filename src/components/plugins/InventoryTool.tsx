import { useState } from "react";
import { useTranslation } from "react-i18next";
import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import PluginSchemaForm from "./PluginSchemaForm";
import {
  editInventoryCell,
  inventoryDraft,
  jsonRecord,
  placementCells,
} from "@/shared/PluginTools";
import type { JsonValue, PluginSchema } from "@/shared/Plugins";

export function InventoryToolForm({
  schema,
  value,
  onChange,
  disabled,
  onInvalid,
}: {
  schema: PluginSchema;
  value: JsonValue;
  onChange: (value: JsonValue) => void;
  disabled?: boolean;
  onInvalid: (path: string, invalid: boolean) => void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"empty" | "clear" | number>("empty");
  const [rotated, setRotated] = useState(false);
  const [invalidPlacement, setInvalidPlacement] = useState(false);
  const draft = inventoryDraft(value);
  const input = jsonRecord(value);
  const update = (index: number) => {
    const next = editInventoryCell(draft, index, mode, rotated);
    setInvalidPlacement(!next);
    if (next)
      onChange({
        ...input,
        empty_cells: next.empty_cells,
        placed: next.placed.map((piece) => ({ ...piece })),
      });
  };
  return (
    <div className="min-w-0 space-y-4">
      <PluginSchemaForm
        schema={{ type: "object", properties: { items: schema.properties?.items ?? {} } }}
        value={{ items: input.items ?? [] }}
        disabled={disabled}
        onInvalid={onInvalid}
        onChange={(next) => {
          setInvalidPlacement(false);
          onChange({ ...input, ...jsonRecord(next), empty_cells: [], placed: [] });
        }}
      />
      <p className="text-xs text-muted-foreground">{t("pluginTools.inventory.hint")}</p>
      <div className="flex flex-wrap gap-2" aria-label={t("pluginTools.inventory.mode")}>
        <Button
          size="sm"
          variant={mode === "empty" ? "default" : "outline"}
          disabled={disabled}
          onClick={() => setMode("empty")}
        >
          {t("pluginTools.inventory.empty")}
        </Button>
        {[0, 1, 2].map((group) => (
          <Button
            key={group}
            size="sm"
            variant={mode === group ? "default" : "outline"}
            disabled={disabled}
            onClick={() => setMode(group)}
          >
            {t("pluginTools.inventory.group", { group: "ABC"[group] })}
          </Button>
        ))}
        <Button
          size="sm"
          variant={mode === "clear" ? "default" : "outline"}
          disabled={disabled}
          onClick={() => setMode("clear")}
        >
          {t("pluginTools.inventory.clear")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          aria-pressed={rotated}
          disabled={disabled || typeof mode !== "number"}
          onClick={() => setRotated((current) => !current)}
        >
          <RotateCw className="size-4" />
          {t("pluginTools.inventory.rotate")}
        </Button>
      </div>
      <div
        className="min-w-0 overflow-x-auto rounded-lg border border-border p-2"
        role="group"
        aria-label={t("pluginTools.inventory.board")}
      >
        <div className="grid min-w-64 grid-cols-9 gap-1">
          {Array.from({ length: 45 }, (_, index) => {
            const piece = draft.placed.find((entry) =>
              placementCells(draft.items[entry.item_index], entry).includes(index)
            );
            const empty = draft.empty_cells.includes(index);
            return (
              <button
                key={index}
                type="button"
                disabled={disabled}
                onClick={() => update(index)}
                aria-label={t("pluginTools.inventory.cell", {
                  row: Math.floor(index / 9) + 1,
                  col: (index % 9) + 1,
                })}
                aria-pressed={Boolean(piece) || empty}
                className={`aspect-square min-h-7 rounded-md border text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring ${piece ? "border-primary/50 bg-primary/15 text-primary" : empty ? "border-border bg-secondary text-muted-foreground" : "border-border bg-background hover:bg-secondary"}`}
              >
                {piece ? "ABC"[piece.item_index] : empty ? "×" : "·"}
              </button>
            );
          })}
        </div>
      </div>
      {invalidPlacement && (
        <p role="alert" className="text-xs text-destructive">
          {t("pluginTools.inventory.invalidPlacement")}
        </p>
      )}
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled}
        onClick={() => {
          onChange({ ...input, empty_cells: [], placed: [] });
          setInvalidPlacement(false);
        }}
      >
        {t("pluginTools.inventory.reset")}
      </Button>
    </div>
  );
}

export function InventoryToolResult({ value }: { value: JsonValue }) {
  const { t } = useTranslation();
  const result = jsonRecord(value);
  const cells = Array.isArray(result.cells) ? result.cells.map(jsonRecord) : [];
  const best = Array.isArray(result.best_cells) ? result.best_cells : [];
  return (
    <div className="min-w-0 space-y-3" data-inventory-result>
      <p role="status" className="text-sm">
        {result.status === "solved"
          ? t("pluginTools.inventory.solved", {
              arrangements: String(result.total_arrangements ?? "0"),
            })
          : result.status === "limit"
            ? t("pluginTools.inventory.limit")
            : t("pluginTools.inventory.impossible")}
      </p>
      {result.status === "solved" && cells.length === 45 && (
        <div className="overflow-x-auto rounded-lg border border-border p-2">
          <div className="grid min-w-64 grid-cols-9 gap-1">
            {cells.map((cell, index) => {
              const probability = typeof cell.any_item === "number" ? cell.any_item : 0;
              return (
                <div
                  key={index}
                  title={["A", "B", "C"]
                    .map(
                      (name, group) =>
                        `${name}: ${(Number(cell[["group_a", "group_b", "group_c"][group]]) * 100).toFixed(1)}%`
                    )
                    .join(" · ")}
                  className={`flex aspect-square items-center justify-center rounded-md border text-[10px] tabular-nums ${best.includes(index) ? "border-primary ring-1 ring-primary" : "border-border"}`}
                  style={{
                    background: `color-mix(in srgb, var(--primary) ${Math.round(probability * 35)}%, var(--background))`,
                  }}
                >
                  {cell.revealed ? "—" : `${Math.round(probability * 100)}%`}
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{t("pluginTools.inventory.best")}</p>
        </div>
      )}
    </div>
  );
}

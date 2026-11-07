import React, { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { FieldEditor, type EditableField, type FieldEditorProps } from "./field-editor";
import { HitBox, Marquee } from "./terminal-components";
import { translate } from "./i18n";
import { terminalText, truncateText } from "./ui";

const TEAL = "#70d7e5",
  MUTED = "#89969f",
  GREEN = "#98cf9e",
  RED = "#f38b91",
  SELECTED = "#203f49";

/** Fixed regional tables keep every area's controls visible and editable in place. */
export function TableEditor({
  field,
  language,
  width,
  height,
  onSave,
  onCancel,
  active = true,
}: FieldEditorProps) {
  const t = (value: string) => translate(value, language);
  const [draft, setDraft] = useState<Record<string, unknown>[]>(
    () => structuredClone(field.editorValue ?? field.value ?? []) as Record<string, unknown>[]
  );
  const [selected, setSelected] = useState(0);
  const [columnIndex, setColumnIndex] = useState(0);
  const [child, setChild] = useState<{ row: number; column: number }>();
  const [saving, setSaving] = useState(false);
  const pendingSave = useRef(false);
  const [error, setError] = useState("");
  const columns = field.columns || [];
  const editable = active && !field.readOnly && !saving;
  const compact = height < 10;
  const tableHeight = Math.max(
    2,
    height - 2 - (compact ? 0 : 1) - (height >= 7 ? 1 : 0) - (error || saving ? 1 : 0)
  );
  const limit = Math.max(1, tableHeight - 1);
  const offset = Math.max(0, Math.min(selected - Math.floor(limit / 2), draft.length - limit));
  const innerWidth = Math.max(1, width - 2);
  const labelWidth = Math.min(28, Math.max(8, Math.floor(innerWidth * 0.38)));
  const cellsWidth = Math.max(1, innerWidth - labelWidth - 1);
  const visibleCount = Math.max(1, Math.min(columns.length, Math.floor(cellsWidth / 10)));
  const firstColumn = Math.max(
    0,
    Math.min(columnIndex - visibleCount + 1, columns.length - visibleCount)
  );
  const visibleColumns = columns.slice(firstColumn, firstColumn + visibleCount);
  const cellWidth = Math.max(1, Math.floor(cellsWidth / visibleCount));
  const update = (row: number, column: number, value: unknown) => {
    if (
      !editable ||
      pendingSave.current ||
      !draft[row] ||
      !columns[column] ||
      columns[column].readOnly
    )
      return;
    setDraft((previous) =>
      previous.map((entry, index) =>
        index === row ? { ...entry, [columns[column].key]: value } : entry
      )
    );
    setError("");
  };
  const increment = (row: number, column: number, delta: number) => {
    const definition = columns[column];
    if (
      !editable ||
      pendingSave.current ||
      !definition ||
      definition.readOnly ||
      definition.type !== "number" ||
      !draft[row]
    )
      return;
    const current = Number(draft[row][definition.key]);
    if (!Number.isFinite(current)) return;
    const value = Math.min(
      definition.max ?? Number.MAX_SAFE_INTEGER,
      Math.max(
        definition.min ?? -Number.MAX_SAFE_INTEGER,
        Number((current + delta * (definition.step ?? 1)).toFixed(10))
      )
    );
    setSelected(row);
    setColumnIndex(column);
    update(row, column, value);
  };
  const edit = (row: number, column: number) => {
    if (
      !editable ||
      pendingSave.current ||
      !draft[row] ||
      !columns[column] ||
      columns[column].readOnly
    )
      return;
    setSelected(row);
    setColumnIndex(column);
    setChild({ row, column });
  };
  const save = async () => {
    if (!editable || pendingSave.current) return;
    pendingSave.current = true;
    setError("");
    try {
      setSaving(true);
      await onSave(structuredClone(draft));
    } catch (reason) {
      setError(t((reason as Error).message));
    } finally {
      pendingSave.current = false;
      setSaving(false);
    }
  };
  const moveRow = (delta: number) => {
    if (active && !saving)
      setSelected((previous) => Math.max(0, Math.min(draft.length - 1, previous + delta)));
  };
  useInput(
    (input, key) => {
      if (saving) return;
      if (key.escape || (key.ctrl && input === "c")) {
        onCancel();
        return;
      }
      if (key.upArrow || key.downArrow) moveRow(key.downArrow ? 1 : -1);
      else if (key.pageUp || key.pageDown) moveRow(key.pageDown ? limit : -limit);
      else if (key.leftArrow || key.rightArrow || key.tab) {
        const delta = key.leftArrow || (key.tab && key.shift) ? -1 : 1;
        setColumnIndex((previous) => Math.max(0, Math.min(columns.length - 1, previous + delta)));
      } else if (key.ctrl && input === "s") void save();
      else if (key.return || input === " ") edit(selected, columnIndex);
      else if (input === "+" || input === "=") increment(selected, columnIndex, 1);
      else if (input === "-") increment(selected, columnIndex, -1);
    },
    { isActive: active && !child }
  );

  if (child) {
    const column = columns[child.column];
    return (
      <FieldEditor
        field={{
          ...column,
          readOnly: field.readOnly || column.readOnly,
          label: `${field.rowLabels?.[child.row] ?? child.row + 1} · ${column.label}`,
          value: draft[child.row][column.key],
        }}
        language={language}
        width={width}
        height={height}
        active={active && !saving}
        onSave={(value) => {
          update(child.row, child.column, value);
          setChild(undefined);
        }}
        onCancel={() => setChild(undefined)}
      />
    );
  }
  const cellText = (column: EditableField, value: unknown) => {
    if (column.sensitive) return "••••••";
    const label = (item: unknown) =>
      column.options?.find((option) => Object.is(option.value, item))?.label ??
      terminalText(String(item ?? ""));
    return Array.isArray(value) ? value.map(label).join(" › ") || "—" : label(value);
  };
  return (
    <Box flexDirection="column" width={width} height={height} paddingX={1} overflow="hidden">
      <Marquee value={field.label} width={innerWidth} color={TEAL} bold />
      {!compact && <Marquee value={field.description || ""} width={innerWidth} color={MUTED} />}
      <HitBox
        flexDirection="column"
        height={tableHeight}
        flexShrink={0}
        onWheel={moveRow}
        overflow="hidden"
      >
        <Box height={1} flexShrink={0}>
          <Box width={labelWidth} flexShrink={0}>
            <Text color={MUTED} wrap="truncate">
              {field.rowLabels ? t("区域") : "#"}
            </Text>
          </Box>
          <Text color={MUTED}>│</Text>
          {visibleColumns.map((column, index) => (
            <Box key={column.key} width={cellWidth} flexShrink={0}>
              <Text color={firstColumn + index === columnIndex ? TEAL : MUTED} bold wrap="truncate">
                {truncateText(column.label, cellWidth)}
              </Text>
            </Box>
          ))}
        </Box>
        {draft.slice(offset, offset + limit).map((entry, index) => {
          const row = index + offset;
          return (
            <Box key={row} height={1} flexShrink={0}>
              <HitBox
                width={labelWidth}
                flexShrink={0}
                onPress={() => {
                  if (active && !saving) setSelected(row);
                }}
              >
                <Text
                  color={row === selected ? TEAL : undefined}
                  backgroundColor={row === selected ? SELECTED : undefined}
                  wrap="truncate"
                >
                  {truncateText(
                    `${row === selected ? "❯" : " "} ${field.rowLabels?.[row] ?? row + 1}`,
                    labelWidth
                  )}
                </Text>
              </HitBox>
              <Text color={MUTED}>│</Text>
              {visibleColumns.map((column, cell) => {
                const at = firstColumn + cell;
                const focused = row === selected && at === columnIndex;
                const number = column.type === "number" && cellWidth >= 9;
                const valueWidth = number ? cellWidth - 6 : cellWidth;
                const value = entry[column.key];
                return (
                  <Box key={column.key} width={cellWidth} flexShrink={0}>
                    {number && (
                      <HitBox width={3} flexShrink={0} onPress={() => increment(row, at, -1)}>
                        <Text
                          color={
                            editable &&
                            !column.readOnly &&
                            Number(value) > (column.min ?? -Number.MAX_SAFE_INTEGER)
                              ? TEAL
                              : MUTED
                          }
                        >
                          [-]
                        </Text>
                      </HitBox>
                    )}
                    <HitBox width={valueWidth} flexShrink={0} onPress={() => edit(row, at)}>
                      <Text
                        color={focused ? TEAL : undefined}
                        backgroundColor={focused ? SELECTED : undefined}
                        wrap="truncate"
                      >
                        {truncateText(cellText(column, value), valueWidth)}
                      </Text>
                    </HitBox>
                    {number && (
                      <HitBox width={3} flexShrink={0} onPress={() => increment(row, at, 1)}>
                        <Text
                          color={
                            editable &&
                            !column.readOnly &&
                            Number(value) < (column.max ?? Number.MAX_SAFE_INTEGER)
                              ? TEAL
                              : MUTED
                          }
                        >
                          [+]
                        </Text>
                      </HitBox>
                    )}
                  </Box>
                );
              })}
            </Box>
          );
        })}
        {!draft.length && <Text color={MUTED}>{t("没有条目")}</Text>}
      </HitBox>
      {(error || saving) && (
        <Marquee value={error || t("正在保存…")} width={innerWidth} color={error ? RED : MUTED} />
      )}
      <Box height={1} flexShrink={0}>
        <HitBox onPress={() => void save()} paddingRight={3}>
          <Text color={GREEN}>
            {t("保存")}
            {width >= 40 ? " [Ctrl+S]" : ""}
          </Text>
        </HitBox>
        <HitBox
          onPress={() => {
            if (active && !saving) onCancel();
          }}
        >
          <Text color={MUTED}>
            {t("返回")}
            {width >= 40 ? " [Esc]" : ""}
          </Text>
        </HitBox>
      </Box>
      {height >= 7 && (
        <Marquee
          value={t("↑↓ 选择区域 · ←→ 选择列 · +/- 次数 · Enter 编辑")}
          width={innerWidth}
          color={MUTED}
        />
      )}
    </Box>
  );
}

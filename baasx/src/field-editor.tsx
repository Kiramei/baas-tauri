import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { HitBox, Marquee } from "./terminal-components";
import { translate } from "./i18n";
import { displayWidth, terminalText } from "./ui";
import type { ConfigOption } from "./configuration";

export interface EditableField {
  label: string;
  description?: string;
  type: string;
  value?: unknown;
  editorValue?: unknown;
  options?: ConfigOption[];
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  sensitive?: boolean;
  readOnly?: boolean;
  ordered?: boolean;
  columns?: Array<EditableField & { key: string }>;
  allowAdd?: boolean;
  allowRemove?: boolean;
  defaultRow?: Record<string, unknown>;
  rowLabels?: string[];
}
const TEAL = "#70d7e5",
  MUTED = "#89969f",
  GREEN = "#98cf9e",
  RED = "#f38b91",
  SELECTED = "#203f49";
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function FieldEditor({
  field,
  language,
  width,
  height,
  onSave,
  onCancel,
  active = true,
}: {
  field: EditableField;
  language: string;
  width: number;
  height: number;
  onSave: (value: unknown) => Promise<void> | void;
  onCancel: () => void;
  active?: boolean;
}) {
  const t = (s: string) => translate(s, language);
  const [draft, setDraft] = useState<unknown>(() =>
    structuredClone(
      field.editorValue ??
        field.value ??
        (["rows", "list", "multiselect"].includes(field.type) ? [] : "")
    )
  );
  const [selected, setSelected] = useState(() =>
    Math.max(
      0,
      field.options?.findIndex((option) => equal(option.value, field.editorValue ?? field.value)) ||
        0
    )
  );
  const [replace, setReplace] = useState(true);
  const [error, setError] = useState("");
  const [row, setRow] = useState<number>();
  const [child, setChild] = useState<{ field: EditableField; save: (value: unknown) => void }>();
  const [saving, setSaving] = useState(false);
  const rows = Array.isArray(draft) ? draft : [];
  const isChoices =
    field.type === "select" ||
    field.type === "multiselect" ||
    (field.type === "list" && !!field.options?.length);
  const compound = field.type === "rows" || (field.type === "list" && !isChoices);
  const options = field.options || [];
  const columnValue = (column: EditableField, value: unknown) =>
    column.sensitive
      ? "••••••"
      : (column.options?.find((option) => equal(option.value, value))?.label ??
        (typeof value === "boolean"
          ? t(value ? "开启" : "关闭")
          : terminalText(String(value ?? ""))));
  const items =
    row !== undefined
      ? (field.columns || []).map((column) => ({ label: column.label, value: column.key }))
      : isChoices
        ? options
        : compound
          ? rows.map((value, index) => ({
              label:
                field.type === "rows"
                  ? [
                      field.rowLabels?.[index],
                      ...(field.columns || []).map((column) =>
                        columnValue(column, value?.[column.key])
                      ),
                    ]
                      .filter(Boolean)
                      .join(" · ")
                  : String(value),
              value: index,
            }))
          : [];
  const compact = height < 10;
  const contentHeight = Math.max(
    1,
    height - 2 - (compact ? 0 : 1) - (height >= 7 ? 1 : 0) - (error || saving ? 1 : 0)
  );
  const limit = contentHeight;
  const offset = Math.max(0, Math.min(selected - Math.floor(limit / 2), items.length - limit));
  const safeSet = (value: unknown) => {
    if (field.readOnly || saving || !active) return;
    setDraft(value);
    setError("");
  };
  const save = async () => {
    if (saving || field.readOnly || !active) return;
    let value = draft;
    if (field.type === "number") {
      if (String(value).trim() === "" || !Number.isFinite(Number(value))) {
        setError(t("请输入有效数字"));
        return;
      }
      value = Number(value);
      if (
        (field.integer && !Number.isInteger(value)) ||
        (field.min !== undefined && Number(value) < field.min) ||
        (field.max !== undefined && Number(value) > field.max)
      ) {
        setError(`${t("数值超出范围")} ${field.min ?? "−∞"}–${field.max ?? "∞"}`);
        return;
      }
    }
    if (field.sensitive && value === "[REDACTED]") {
      setError(t("请输入新值"));
      return;
    }
    try {
      setSaving(true);
      await onSave(value);
    } catch (error) {
      setError(t((error as Error).message));
    } finally {
      setSaving(false);
    }
  };
  const select = (index: number) => {
    const item = items[index];
    if (!item) return;
    setSelected(index);
    if (row !== undefined) {
      const column = field.columns![index];
      setChild({
        field: { ...column, value: rows[row]?.[column.key] },
        save: (value) => {
          const next = structuredClone(rows);
          next[row] = { ...next[row], [column.key]: value };
          safeSet(next);
          setChild(undefined);
        },
      });
    } else if (isChoices) {
      if (options[index]?.disabled) return;
      if (field.type === "select") safeSet(item.value);
      else
        safeSet(
          rows.some((value) => equal(value, item.value))
            ? rows.filter((value) => !equal(value, item.value))
            : [...rows, item.value]
        );
    } else if (field.type === "rows") {
      setRow(index);
      setSelected(0);
    } else if (field.type === "list")
      setChild({
        field: { label: t("编辑条目"), type: "text", value: rows[index] },
        save: (value) => {
          safeSet(rows.map((v, i) => (i === index ? value : v)));
          setChild(undefined);
        },
      });
  };
  const add = () => {
    if (field.readOnly || field.allowAdd === false) return;
    if (field.type === "rows") {
      safeSet([...rows, structuredClone(field.defaultRow || {})]);
      setRow(rows.length);
      setSelected(0);
    } else
      setChild({
        field: { label: t("添加条目"), type: "text", value: "" },
        save: (value) => {
          if (String(value).trim()) {
            safeSet([...rows, value]);
            setSelected(rows.length);
          }
          setChild(undefined);
        },
      });
  };
  const remove = () => {
    if (!field.readOnly && field.allowRemove !== false) {
      safeSet(rows.filter((_, i) => i !== selected));
      setSelected(Math.max(0, selected - 1));
    }
  };
  const back = () => {
    if (row !== undefined) {
      setRow(undefined);
      setSelected(0);
    } else onCancel();
  };
  useInput(
    (text, key) => {
      if (key.escape) {
        back();
        return;
      }
      if (key.ctrl && text === "c") {
        onCancel();
        return;
      }
      if (field.readOnly || saving) return;
      if (key.ctrl && text === "s") {
        void save();
        return;
      }
      if (field.type === "switch") {
        if (key.leftArrow) safeSet(false);
        else if (key.rightArrow) safeSet(true);
        else if (text === " ") safeSet(!draft);
        else if (key.return) void save();
        return;
      }
      if (isChoices || compound || row !== undefined) {
        if (key.upArrow || key.downArrow) {
          const delta = key.downArrow ? 1 : -1;
          const index = Math.max(0, Math.min(items.length - 1, selected + delta));
          setSelected(index);
          if (field.type === "select" && !options[index]?.disabled) safeSet(options[index]?.value);
          return;
        }
        if (key.return) {
          if (row !== undefined || compound) select(selected);
          else void save();
          return;
        }
        if (text === " " && isChoices) select(selected);
        if (text === "+" && compound && row === undefined) add();
        if ((key.delete || key.backspace) && compound && row === undefined) remove();
        if (field.ordered && (text === "<" || text === ">") && rows.length) {
          const current = items[selected]?.value;
          const at =
            !isChoices && row === undefined ? selected : rows.findIndex((v) => equal(v, current));
          const next = at + (text === ">" ? 1 : -1);
          if (at >= 0 && next >= 0 && next < rows.length) {
            const values = [...rows];
            [values[at], values[next]] = [values[next], values[at]];
            safeSet(values);
            if (!isChoices) setSelected(next);
          }
        }
        return;
      }
      if (key.return) {
        void save();
        return;
      }
      if (key.ctrl && text === "a") {
        safeSet("");
        setReplace(true);
        return;
      }
      if (key.backspace || key.delete) {
        safeSet(
          replace
            ? ""
            : [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(String(draft))]
                .slice(0, -1)
                .map(({ segment }) => segment)
                .join("")
        );
        setReplace(false);
        return;
      }
      if (key.ctrl || key.meta || key.tab || key.leftArrow || key.rightArrow) return;
      const clean = terminalText(text).replace(/[\r\n]/g, "");
      const value = (replace ? "" : String(draft)) + clean;
      if (field.type === "number" && !(field.integer ? /^-?\d*$/ : /^-?\d*(?:\.\d*)?$/).test(value))
        return;
      if (value.length > 8192) return;
      safeSet(value);
      setReplace(false);
    },
    { isActive: active && !child }
  );
  if (child)
    return (
      <FieldEditor
        key={child.field.label}
        field={child.field}
        language={language}
        width={width}
        height={height}
        onSave={child.save}
        onCancel={() => setChild(undefined)}
        active={active}
      />
    );
  const display = field.sensitive ? "•".repeat(String(draft).length) : terminalText(String(draft));
  const tail = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(display)].map(
    ({ segment }) => segment
  );
  while (tail.length && displayWidth(tail.join("")) > Math.max(1, width - 5)) tail.shift();
  return (
    <Box flexDirection="column" width={width} height={height} paddingX={1}>
      <Marquee
        value={`${field.label}${row === undefined ? "" : ` · ${row + 1}`}`}
        width={width - 2}
        color={TEAL}
        bold
      />
      {!compact && <Marquee value={field.description || ""} width={width - 2} color={MUTED} />}
      {field.type === "switch" ? (
        <Box height={contentHeight} flexShrink={0}>
          <HitBox onPress={() => safeSet(false)} paddingRight={3} height={1}>
            <Text color={!draft ? TEAL : MUTED}>
              {!draft ? "❯ " : ""}
              {t("关闭")} ○
            </Text>
          </HitBox>
          <HitBox onPress={() => safeSet(true)} height={1}>
            <Text color={draft ? GREEN : MUTED}>
              {draft ? "❯ " : ""}
              {t("开启")} ●
            </Text>
          </HitBox>
        </Box>
      ) : isChoices || compound || row !== undefined ? (
        <HitBox
          flexDirection="column"
          height={contentHeight}
          flexShrink={0}
          onWheel={(delta) =>
            setSelected((n) => Math.max(0, Math.min(items.length - 1, n + delta)))
          }
        >
          {items.slice(offset, offset + limit).map((item, index) => {
            const focused = index + offset === selected;
            const checked =
              field.type === "select"
                ? equal(draft, item.value)
                : isChoices && rows.some((value) => equal(value, item.value));
            const value =
              row !== undefined
                ? columnValue(field.columns![index + offset], rows[row]?.[String(item.value)])
                : "";
            return (
              <HitBox
                key={index + offset}
                height={1}
                flexShrink={0}
                onPress={() => select(index + offset)}
              >
                <Marquee
                  value={`${focused ? "❯" : " "} ${isChoices ? (checked ? "● " : "○ ") : ""}${item.label}${value ? " · " + value : ""}`}
                  width={width - 2}
                  color={options[index + offset]?.disabled ? MUTED : focused ? TEAL : undefined}
                  backgroundColor={focused ? SELECTED : undefined}
                />
              </HitBox>
            );
          })}
          {!items.length && <Text color={MUTED}>{t("没有条目")}</Text>}
        </HitBox>
      ) : (
        <Box flexDirection="column" height={contentHeight} flexShrink={0}>
          <Text color={TEAL} wrap="truncate">
            ❯ {tail.join("") || " "}
            <Text inverse> </Text>
          </Text>
          {contentHeight >= 2 && (
            <Text color={MUTED} wrap="truncate">
              {field.type === "number"
                ? `${t("数字")} · ${field.min ?? "−∞"}–${field.max ?? "∞"}`
                : t("直接输入文本")}
            </Text>
          )}
        </Box>
      )}
      {(error || saving) && (
        <Marquee color={RED} width={width - 2} value={error || t("正在保存…")} />
      )}
      <Box height={1} flexShrink={0}>
        <HitBox onPress={() => void save()} paddingRight={3}>
          <Text color={GREEN}>
            {t("保存")}
            {width >= 70 ? " [Ctrl+S]" : ""}
          </Text>
        </HitBox>
        {compound && row === undefined && field.allowAdd !== false && (
          <HitBox onPress={add} paddingRight={3}>
            <Text color={TEAL}>
              {t("添加")}
              {width >= 70 ? " [+]" : ""}
            </Text>
          </HitBox>
        )}
        {compound && row === undefined && field.allowRemove !== false && (
          <HitBox onPress={remove} paddingRight={3}>
            <Text color={RED}>
              {t("删除")}
              {width >= 70 ? " [Del]" : ""}
            </Text>
          </HitBox>
        )}
        <HitBox onPress={back}>
          <Text color={MUTED}>
            {t("返回")}
            {width >= 70 ? " [Esc]" : ""}
          </Text>
        </HitBox>
      </Box>
      {height >= 7 && (
        <Marquee
          color={MUTED}
          width={width - 2}
          value={
            field.type === "switch"
              ? t("← 关闭 · → 开启 · Enter 保存")
              : field.ordered
                ? t("Space 选择 · < > 调整顺序 · Ctrl+S 保存")
                : t("↑↓ 选择 · Enter 确认 · Esc 返回")
          }
        />
      )}
    </Box>
  );
}

import React, { useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { EditableField } from "./field-editor";
import { translate } from "./i18n";
import { HitBox, Marquee } from "./terminal-components";
import { terminalText } from "./ui";

const TEAL = "#70d7e5",
  MUTED = "#89969f",
  GREEN = "#98cf9e",
  RED = "#f38b91",
  SELECTED = "#203f49";
const identity = (value: unknown) => JSON.stringify(value);

export interface PriorityEditorProps {
  field: EditableField;
  language: string;
  width: number;
  height: number;
  onSave: (value: unknown) => Promise<void> | void;
  onCancel: () => void;
  active?: boolean;
}

function Action({
  label,
  width,
  enabled,
  color = TEAL,
  onPress,
}: {
  label: string;
  width: number;
  enabled: boolean;
  color?: string;
  onPress: () => void;
}) {
  return (
    <HitBox width={width} height={1} flexShrink={0} onPress={enabled ? onPress : undefined}>
      <Marquee value={label} width={width} color={enabled ? color : MUTED} />
    </HitBox>
  );
}

/** Keep the displayed order identical to the saved priority order. */
export function PriorityEditor({
  field,
  language,
  width,
  height,
  onSave,
  onCancel,
  active = true,
}: PriorityEditorProps) {
  const t = (text: string) => translate(text, language);
  const [draft, setDraft] = useState<unknown[]>(() => {
    const initial = field.editorValue ?? field.value;
    return Array.isArray(initial) ? structuredClone(initial) : [];
  });
  const [focus, setFocus] = useState<string>();
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const pendingSave = useRef(false);
  const items = useMemo(() => {
    const options = new Map(
      (field.options || []).map((option) => [identity(option.value), option])
    );
    const selected = new Set(draft.map(identity));
    const all = [
      ...draft.map((value, rank) => {
        const option = options.get(identity(value));
        return {
          value,
          key: identity(value),
          label: option?.label ?? terminalText(String(value)),
          rank,
          disabled: !!option?.disabled,
        };
      }),
      ...[...options.values()]
        .filter((option) => !selected.has(identity(option.value)))
        .map((option) => ({
          ...option,
          key: identity(option.value),
          rank: undefined as number | undefined,
          disabled: !!option.disabled,
        })),
    ];
    const needle = query.trim().toLocaleLowerCase();
    return needle
      ? all.filter((item) =>
          `${item.label} ${String(item.value)}`.toLocaleLowerCase().includes(needle)
        )
      : all;
  }, [draft, field.options, query]);
  const index = Math.max(
    0,
    items.findIndex((item) => item.key === focus)
  );
  const current = items[index];
  const writable = active && !field.readOnly && !saving;
  const innerWidth = Math.max(1, width - 2);
  const descriptionVisible = height >= 12;
  const searchVisible = height >= 7 || searching || !!query;
  const countVisible = height >= 8;
  const hintVisible = height >= 10;
  const contentHeight = Math.max(
    1,
    height -
      3 -
      Number(descriptionVisible) -
      Number(searchVisible) -
      Number(countVisible) -
      Number(hintVisible) -
      Number(!!error || saving)
  );
  const offset = Math.max(
    0,
    Math.min(index - Math.floor(contentHeight / 2), items.length - contentHeight)
  );
  const move = (delta: number) => {
    if (!writable || pendingSave.current || current?.rank === undefined) return;
    const next = current.rank + delta;
    if (next < 0 || next >= draft.length) return;
    const values = [...draft];
    [values[current.rank], values[next]] = [values[next], values[current.rank]];
    setDraft(values);
    setFocus(current.key);
    setError("");
  };
  const toggle = (item = current) => {
    if (!writable || pendingSave.current || !item || (item.rank === undefined && item.disabled))
      return;
    if (item.rank === undefined && field.allowAdd === false) return;
    if (item.rank !== undefined && field.allowRemove === false) return;
    setDraft(
      item.rank === undefined ? [...draft, item.value] : draft.filter((_, i) => i !== item.rank)
    );
    setFocus(item.key);
    setError("");
  };
  const save = async () => {
    if (!writable || pendingSave.current) return;
    pendingSave.current = true;
    setSaving(true);
    setError("");
    try {
      await onSave(structuredClone(draft));
    } catch (failure) {
      setError(t((failure as Error).message));
    } finally {
      pendingSave.current = false;
      setSaving(false);
    }
  };
  const navigate = (delta: number) => {
    if (!active || saving) return;
    const next = Math.max(0, Math.min(items.length - 1, index + delta));
    setFocus(items[next]?.key);
  };
  useInput(
    (text, key) => {
      if (saving || pendingSave.current) return;
      if (key.escape) {
        if (searching || query) {
          setSearching(false);
          setQuery("");
        } else onCancel();
        return;
      }
      if (key.ctrl && text === "c") {
        onCancel();
        return;
      }
      if (key.ctrl && text === "s") {
        void save();
        return;
      }
      if (searching) {
        if (key.return) setSearching(false);
        else if (key.backspace || key.delete) setQuery((value) => [...value].slice(0, -1).join(""));
        else if (key.ctrl && text === "a") setQuery("");
        else if (
          !key.ctrl &&
          !key.meta &&
          !key.tab &&
          !key.upArrow &&
          !key.downArrow &&
          !key.leftArrow &&
          !key.rightArrow
        ) {
          setQuery((value) => (value + terminalText(text).replace(/[\r\n]/g, "")).slice(0, 200));
          setFocus(undefined);
        }
        return;
      }
      if (key.leftArrow || text === "<" || (key.ctrl && key.upArrow)) move(-1);
      else if (key.rightArrow || text === ">" || (key.ctrl && key.downArrow)) move(1);
      else if (key.upArrow) navigate(-1);
      else if (key.downArrow) navigate(1);
      else if (key.pageUp) navigate(-contentHeight);
      else if (key.pageDown) navigate(contentHeight);
      else if (text === "/") setSearching(true);
      else if (text === " ") toggle();
      else if ((key.backspace || key.delete) && current?.rank !== undefined) toggle();
      else if (key.return) void save();
    },
    { isActive: active }
  );

  const third = Math.floor(innerWidth / 3);
  const canToggle =
    writable &&
    !!current &&
    (current.rank !== undefined || !current.disabled) &&
    (current.rank === undefined ? field.allowAdd !== false : field.allowRemove !== false);
  return (
    <Box flexDirection="column" width={width} height={height} paddingX={1} overflow="hidden">
      <Marquee value={field.label} width={innerWidth} color={TEAL} bold />
      {descriptionVisible && (
        <Marquee value={field.description || ""} width={innerWidth} color={MUTED} />
      )}
      {searchVisible && (
        <HitBox height={1} flexShrink={0} onPress={() => active && !saving && setSearching(true)}>
          <Marquee
            value={`${searching ? "❯" : "/"} ${t("搜索条目")}: ${query}${searching ? " ▏" : ""}`}
            width={innerWidth}
            color={searching ? TEAL : MUTED}
          />
        </HitBox>
      )}
      {countVisible && (
        <Marquee
          value={t("已选 {count} 项 · 越靠上优先级越高").replace("{count}", String(draft.length))}
          width={innerWidth}
          color={MUTED}
        />
      )}
      <HitBox height={contentHeight} flexShrink={0} flexDirection="column" onWheel={navigate}>
        {items.slice(offset, offset + contentHeight).map((item, visibleIndex) => {
          const focused = index === visibleIndex + offset;
          const labelWidth = Math.max(1, innerWidth - 4);
          return (
            <Box key={`${item.key}:${item.rank ?? "available"}`} height={1} flexShrink={0}>
              <HitBox width={labelWidth} onPress={() => active && !saving && setFocus(item.key)}>
                <Marquee
                  value={`${focused ? "❯" : " "} ${item.rank === undefined ? "○" : `${item.rank + 1}.`} ${item.label}`}
                  width={labelWidth}
                  color={item.disabled ? MUTED : focused ? TEAL : undefined}
                  backgroundColor={focused ? SELECTED : undefined}
                />
              </HitBox>
              <HitBox width={3} marginLeft={1} onPress={() => toggle(item)}>
                <Text
                  color={
                    !writable ||
                    (item.rank === undefined && item.disabled) ||
                    (item.rank === undefined
                      ? field.allowAdd === false
                      : field.allowRemove === false)
                      ? MUTED
                      : item.rank === undefined
                        ? GREEN
                        : RED
                  }
                >
                  {item.rank === undefined ? "[+]" : "[−]"}
                </Text>
              </HitBox>
            </Box>
          );
        })}
        {!items.length && <Text color={MUTED}>{t("没有条目")}</Text>}
      </HitBox>
      {(error || saving) && (
        <Marquee value={error || t("正在保存…")} width={innerWidth} color={RED} />
      )}
      <Box height={1} flexShrink={0}>
        <Action
          label={`↑ ${t("上移")}`}
          width={third}
          enabled={writable && current?.rank !== undefined && current.rank > 0}
          onPress={() => move(-1)}
        />
        <Action
          label={`↓ ${t("下移")}`}
          width={third}
          enabled={writable && current?.rank !== undefined && current.rank < draft.length - 1}
          onPress={() => move(1)}
        />
        <Action
          label={t(current?.rank === undefined ? "添加" : "移除")}
          width={innerWidth - third * 2}
          enabled={canToggle}
          onPress={() => toggle()}
        />
      </Box>
      <Box height={1} flexShrink={0}>
        <Action
          label={`${t("保存")} [Ctrl+S]`}
          width={Math.floor(innerWidth / 2)}
          color={GREEN}
          enabled={writable}
          onPress={() => void save()}
        />
        <Action
          label={`${t("返回")} [Esc]`}
          width={Math.ceil(innerWidth / 2)}
          color={MUTED}
          enabled={active && !saving}
          onPress={onCancel}
        />
      </Box>
      {hintVisible && (
        <Marquee
          value={t(
            searching
              ? "输入名称筛选 · Enter 完成 · Esc 清除"
              : "↑↓ 选择 · ←→ 移动 · Space 添加/移除 · / 搜索"
          )}
          width={innerWidth}
          color={MUTED}
        />
      )}
    </Box>
  );
}

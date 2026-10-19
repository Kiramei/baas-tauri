import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Check, GripVertical, Plus, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/Popover";
import { SearchInput } from "@/components/ui/SearchInput";
import { useAppTranslation } from "@/shared/useAppTranslation";
import { movePriorityEntry, priorityDropIndex, selectPriorityEntry } from "@/shared/PriorityOrder";
import "./priority-list-editor.css";

interface PriorityListEditorProps {
  value: readonly string[];
  options: readonly string[];
  onChange: (value: string[]) => void;
  ariaLabel: string;
}

interface ReorderSession {
  source: readonly string[];
  order: number[];
  active: number;
  input: "pointer" | "keyboard";
  pointerId?: number;
  startY: number;
  y: number;
  left: number;
  width: number;
  height: number;
  moving: boolean;
}

/** Reordering previews locally and commits once; backend labels remain byte-for-byte unchanged. */
export function PriorityListEditor({
  value,
  options,
  onChange,
  ariaLabel,
}: PriorityListEditorProps) {
  const { t } = useAppTranslation();
  const helpId = useId();
  const listRef = useRef<HTMLOListElement>(null);
  const sessionRef = useRef<ReorderSession | null>(null);
  const [session, setSession] = useState<ReorderSession | null>(null);
  const [query, setQuery] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const known = [...new Set(options.filter((item) => item.length > 0))];
  const filtered = known.filter((item) =>
    item.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  );
  // A simultaneous external update or undo wins over an unfinished drag.
  const currentSession = session?.source === value ? session : null;
  const order = currentSession?.order ?? value.map((_, index) => index);
  const source = currentSession?.source ?? value;

  useEffect(() => {
    const cancel = () => {
      sessionRef.current = null;
      setSession(null);
    };
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("blur", cancel);
      // Activity can hide a cached page while a pointer is held down.
      cancel();
    };
  }, []);

  const pointerActive = currentSession?.input === "pointer" && currentSession.moving;
  useEffect(() => {
    if (!pointerActive) return;
    let frame: number;
    const scroll = () => {
      const active = sessionRef.current;
      const list = listRef.current;
      if (!active || active.input !== "pointer" || active.source !== value || !list) return;
      const bounds = list.getBoundingClientRect();
      const before = list.scrollTop;
      if (active.y < bounds.top + 28) list.scrollTop -= 5;
      else if (active.y > bounds.bottom - 28) list.scrollTop += 5;
      if (before !== list.scrollTop) {
        const centers = Array.from(list.querySelectorAll<HTMLElement>("[data-priority-row]"))
          .filter((row) => Number(row.dataset.priorityRow) !== active.active)
          .map((row) => {
            const rect = row.getBoundingClientRect();
            return rect.top + rect.height / 2;
          });
        const next = {
          ...active,
          order: movePriorityEntry(
            active.order,
            active.order.indexOf(active.active),
            priorityDropIndex(active.y, centers)
          ),
        };
        sessionRef.current = next;
        setSession(next);
      }
      frame = requestAnimationFrame(scroll);
    };
    frame = requestAnimationFrame(scroll);
    return () => cancelAnimationFrame(frame);
  }, [pointerActive, value]);

  const updateSession = (next: ReorderSession | null) => {
    sessionRef.current = next;
    setSession(next);
  };
  const announce = (next: ReorderSession) => {
    setAnnouncement(
      t("friendlyPriority.position", {
        item: next.source[next.active] || t("friendlyPriority.emptyLegacy"),
        position: next.order.indexOf(next.active) + 1,
        total: next.order.length,
      })
    );
  };
  const finish = (commit: boolean, restoreFocus = false) => {
    const active = sessionRef.current;
    updateSession(null);
    if (!active || !commit || active.source !== value) return;
    if (restoreFocus) {
      const position = active.order.indexOf(active.active);
      requestAnimationFrame(() => {
        listRef.current
          ?.querySelector<HTMLButtonElement>(`[data-priority-row="${position}"] button`)
          ?.focus({ preventScroll: true });
      });
    }
    if (active.order.every((original, index) => original === index)) return;
    onChange(active.order.map((original) => active.source[original]));
  };
  const begin = (index: number, input: ReorderSession["input"]): ReorderSession => ({
    source: value,
    order: value.map((_, position) => position),
    active: index,
    input,
    startY: 0,
    y: 0,
    left: 0,
    width: 0,
    height: 0,
    moving: input === "keyboard",
  });
  const pointerDown = (event: PointerEvent<HTMLButtonElement>, index: number) => {
    if (!event.isPrimary || event.button !== 0 || value.length < 2) return;
    const row = event.currentTarget.closest("li");
    if (!row) return;
    const rect = row.getBoundingClientRect();
    event.preventDefault();
    event.currentTarget.focus();
    // The list stays in place while React moves rows; capturing a moving handle loses the drag.
    listRef.current?.setPointerCapture(event.pointerId);
    updateSession({
      ...begin(index, "pointer"),
      pointerId: event.pointerId,
      startY: event.clientY,
      y: event.clientY,
      left: rect.left,
      width: rect.width,
      height: rect.height,
    });
  };
  const pointerMove = (event: PointerEvent<HTMLOListElement>) => {
    const active = sessionRef.current;
    if (!active || active.input !== "pointer" || active.pointerId !== event.pointerId) return;
    if (active.source !== value) return finish(false);
    if (!active.moving && Math.abs(event.clientY - active.startY) < 4) return;
    const list = listRef.current;
    if (!list) return;
    // Keep a long list reachable on touch as well as with the mouse.
    const bounds = list.getBoundingClientRect();
    if (event.clientY < bounds.top + 28) list.scrollTop -= 16;
    else if (event.clientY > bounds.bottom - 28) list.scrollTop += 16;
    const centers = Array.from(list.querySelectorAll<HTMLElement>("[data-priority-row]"))
      .filter((row) => Number(row.dataset.priorityRow) !== active.active)
      .map((row) => {
        const rect = row.getBoundingClientRect();
        return rect.top + rect.height / 2;
      });
    const target = priorityDropIndex(event.clientY, centers);
    const next = {
      ...active,
      order: movePriorityEntry(active.order, active.order.indexOf(active.active), target),
      moving: true,
      y: event.clientY,
    };
    updateSession(next);
  };
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let active = sessionRef.current;
    if (event.key === "Escape" && active) {
      event.preventDefault();
      event.stopPropagation();
      finish(false);
      return;
    }
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      if (active?.input === "keyboard") return finish(true, true);
      active = begin(index, "keyboard");
      updateSession(active);
      announce(active);
      return;
    }
    if (!active || active.input !== "keyboard" || active.source !== value) return;
    const position = active.order.indexOf(active.active);
    const target =
      event.key === "ArrowUp"
        ? Math.max(0, position - 1)
        : event.key === "ArrowDown"
          ? Math.min(active.order.length - 1, position + 1)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? active.order.length - 1
              : null;
    if (target === null) return;
    event.preventDefault();
    const next = { ...active, order: movePriorityEntry(active.order, position, target) };
    updateSession(next);
    announce(next);
    listRef.current
      ?.querySelector<HTMLElement>(`[data-priority-row="${active.active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  };

  return (
    <div className="priority-editor" role="group" aria-label={ariaLabel}>
      <p id={helpId} className="sr-only">
        {t("friendlyPriority.keyboardHint")}
      </p>
      <ol
        ref={listRef}
        className="priority-editor-list"
        onPointerMove={pointerMove}
        onPointerUp={(event) => {
          if (sessionRef.current?.pointerId === event.pointerId) finish(true, true);
        }}
        onPointerCancel={() => finish(false)}
        onLostPointerCapture={() => {
          if (sessionRef.current?.input === "pointer") finish(false);
        }}
      >
        {order.map((originalIndex, position) => {
          const item = source[originalIndex];
          const picked = currentSession?.active === originalIndex && currentSession.moving;
          return (
            <li
              key={originalIndex}
              data-priority-row={originalIndex}
              data-picked={picked || undefined}
              className="priority-editor-row"
            >
              <button
                type="button"
                className="priority-editor-handle"
                aria-label={t("friendlyPriority.reorderItem", {
                  item: item || t("friendlyPriority.emptyLegacy"),
                })}
                aria-describedby={helpId}
                title={t("friendlyPriority.reorderHint")}
                aria-pressed={picked}
                disabled={value.length < 2}
                onPointerDown={(event) => pointerDown(event, originalIndex)}
                onKeyDown={(event) => keyDown(event, originalIndex)}
                onBlur={() => {
                  if (sessionRef.current?.input === "keyboard") finish(true);
                }}
              >
                <GripVertical size={16} aria-hidden="true" />
              </button>
              <span className="priority-editor-number" aria-hidden="true">
                {position + 1}
              </span>
              <span className="priority-editor-name">
                {item || t("friendlyPriority.emptyLegacy")}
              </span>
              <button
                type="button"
                className="priority-editor-remove"
                aria-label={`${t("common.delete")}: ${item || t("friendlyPriority.emptyLegacy")}`}
                disabled={Boolean(currentSession)}
                onClick={() =>
                  onChange(value.filter((_, itemIndex) => itemIndex !== originalIndex))
                }
              >
                <X size={15} aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ol>
      {value.length === 0 && (
        <p className="priority-editor-empty">{t("friendlyPriority.emptyPriority")}</p>
      )}
      {known.length > 0 && (
        <Popover onOpenChange={() => setQuery("")}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="priority-editor-add"
              disabled={Boolean(currentSession)}
            >
              <Plus size={15} aria-hidden="true" />
              {t("friendlyPriority.selectNodes")}
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="priority-editor-picker">
            <SearchInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("friendlyPriority.searchNodes")}
            />
            <div
              className="priority-editor-choices"
              role="group"
              aria-label={t("friendlyPriority.selectNodes")}
            >
              {filtered.map((item) => {
                const selected = value.includes(item);
                return (
                  <button
                    key={item}
                    type="button"
                    role="checkbox"
                    aria-checked={selected}
                    className="priority-editor-choice"
                    onClick={() => onChange(selectPriorityEntry(value, item, !selected))}
                  >
                    <span
                      className="priority-editor-check"
                      data-checked={selected || undefined}
                      aria-hidden="true"
                    >
                      {selected && <Check size={12} />}
                    </span>
                    <span>{item}</span>
                  </button>
                );
              })}
              {filtered.length === 0 && (
                <p className="priority-editor-empty">{t("friendlyPriority.noResults")}</p>
              )}
            </div>
          </PopoverContent>
        </Popover>
      )}
      {currentSession?.input === "pointer" && currentSession.moving && (
        <div
          className="priority-editor-drag-preview"
          aria-hidden="true"
          style={{
            left: currentSession.left,
            top: currentSession.y - currentSession.height / 2,
            width: currentSession.width,
            minHeight: currentSession.height,
          }}
        >
          <GripVertical size={16} />
          <span>
            {currentSession.source[currentSession.active] || t("friendlyPriority.emptyLegacy")}
          </span>
        </div>
      )}
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </div>
  );
}

import { useId, useRef, useState } from "react";
import { Check } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/Popover";

export type TitlebarMenuItem = {
  id: string;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  checked?: boolean;
  onSelect: () => void;
};
export type TitlebarMenuEntry = TitlebarMenuItem | { id: string; separator: true };

export interface TitlebarMenuControl {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onAdjacent?: (direction: -1 | 1) => void;
  onPointerEnter?: () => void;
}

interface TitlebarMenuProps extends TitlebarMenuControl {
  label: string;
  entries: TitlebarMenuEntry[];
  onCapture?: () => void;
}

/** Shared custom menu surface, keyboard navigation and focus handoff for the titlebar. */
export default function TitlebarMenu({
  label,
  entries,
  open: controlledOpen,
  onOpenChange,
  onAdjacent,
  onPointerEnter,
  onCapture,
}: TitlebarMenuProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (next: boolean) => {
    setInternalOpen(next);
    onOpenChange?.(next);
  };
  const triggerId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const initialLast = useRef(false);
  const skipCloseFocus = useRef(false);
  const enabledItems = () =>
    Array.from(
      menu.current?.querySelectorAll<HTMLButtonElement>("[role^='menuitem']:not(:disabled)") ?? []
    );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          ref={trigger}
          type="button"
          id={triggerId}
          role="menuitem"
          aria-haspopup="menu"
          className={`flex h-7 items-center rounded-lg px-2.5 text-[13px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40 ${open ? "bg-sidebar-accent text-foreground" : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"}`}
          onPointerDown={onCapture}
          onPointerEnter={onPointerEnter}
          onKeyDown={(event) => {
            if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) onCapture?.();
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              initialLast.current = event.key === "ArrowUp";
              setOpen(true);
            }
            if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && onAdjacent) {
              event.preventDefault();
              onAdjacent(event.key === "ArrowRight" ? 1 : -1);
            }
          }}
          onClick={() => {
            initialLast.current = false;
          }}
        >
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent
        ref={menu}
        role="menu"
        aria-labelledby={triggerId}
        align="start"
        sideOffset={4}
        collisionPadding={8}
        className="w-[240px] max-w-[calc(100vw-16px)] select-none p-[6px]"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const items = enabledItems();
          (initialLast.current ? items.at(-1) : items[0])?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          if (!skipCloseFocus.current) return;
          event.preventDefault();
          skipCloseFocus.current = false;
        }}
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            const items = enabledItems();
            const current = items.indexOf(document.activeElement as HTMLButtonElement);
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? items.length - 1
                  : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
            items[next]?.focus({ preventScroll: true });
          }
          if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && onAdjacent) {
            event.preventDefault();
            skipCloseFocus.current = true;
            onAdjacent(event.key === "ArrowRight" ? 1 : -1);
          }
          if (event.key === "Tab") setOpen(false);
        }}
      >
        {entries.map((entry) =>
          "separator" in entry ? (
            <div
              key={entry.id}
              role="separator"
              className="-mx-[6px] my-[6px] h-px bg-[var(--menu-border)]"
            />
          ) : (
            <button
              key={entry.id}
              type="button"
              role={entry.checked === undefined ? "menuitem" : "menuitemcheckbox"}
              aria-checked={entry.checked}
              disabled={entry.disabled}
              className="flex h-7 w-full cursor-default items-center gap-2 rounded-[4px] px-3 text-left text-[13px] leading-5 outline-none hover:bg-[var(--menu-hover)] focus-visible:bg-[var(--menu-hover)] disabled:pointer-events-none disabled:opacity-40"
              onClick={() => {
                skipCloseFocus.current = true;
                setOpen(false);
                trigger.current?.focus({ preventScroll: true });
                entry.onSelect();
              }}
            >
              <span className="min-w-0 flex-1">{entry.label}</span>
              {entry.shortcut && (
                <span className="shrink-0 text-xs text-muted-foreground">{entry.shortcut}</span>
              )}
              {entry.checked && <Check className="size-3.5 shrink-0" aria-hidden="true" />}
            </button>
          )
        )}
      </PopoverContent>
    </Popover>
  );
}

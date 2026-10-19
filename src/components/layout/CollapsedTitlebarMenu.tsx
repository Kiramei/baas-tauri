import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { DropdownMenu } from "radix-ui";
import { Check, ChevronLeft, ChevronRight, Ellipsis } from "lucide-react";
import { useAppTranslation } from "@/shared/useAppTranslation";
import type { TitlebarMenuEntry, TitlebarMenuItem } from "./TitlebarMenu";
import "./collapsed-titlebar-menu.css";

export type CollapsedMenuGroup = {
  id: string;
  label: string;
  entries: TitlebarMenuEntry[];
};

interface CollapsedTitlebarMenuProps {
  groups: CollapsedMenuGroup[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCapture: () => void;
  onCategoryOpen: (id: string) => void;
  drilldown: boolean;
}

/** Keep all actions visible when two menu columns cannot fit in a narrow window. */
export default function CollapsedTitlebarMenu({
  groups,
  open,
  onOpenChange,
  onCapture,
  onCategoryOpen,
  drilldown,
}: CollapsedTitlebarMenuProps) {
  const { t } = useAppTranslation();
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const selectedAction = useRef(false);
  const returnGroup = useRef<string | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const group = groups.find(({ id }) => id === activeGroup);
  const clearHover = () => {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  };
  useEffect(() => () => clearHover(), []);
  useEffect(() => {
    if (!open) clearHover();
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !drilldown) return;
    if (activeGroup) {
      const firstAction = content.current?.querySelector<HTMLElement>(
        "[data-collapsed-leaf]:not([data-disabled])"
      );
      const back = content.current?.querySelector<HTMLElement>(".collapsed-menu-back");
      (firstAction ?? back)?.focus({ preventScroll: true });
    } else if (returnGroup.current) {
      content.current
        ?.querySelector<HTMLElement>(`[data-collapsed-category="${returnGroup.current}"]`)
        ?.focus({ preventScroll: true });
      returnGroup.current = null;
    }
  }, [activeGroup, drilldown, open]);

  const changeOpen = (next: boolean) => {
    clearHover();
    setActiveGroup(null);
    returnGroup.current = null;
    onOpenChange(next);
  };
  const enterGroup = (id: string) => {
    clearHover();
    onCategoryOpen(id);
    setActiveGroup(id);
  };
  const leaveGroup = () => {
    clearHover();
    returnGroup.current = activeGroup;
    setActiveGroup(null);
  };
  const selectAction = (entry: TitlebarMenuItem) => {
    selectedAction.current = true;
    changeOpen(false);
    // Restore focus before the action, so a newly opened dialog or editor keeps it.
    trigger.current?.focus({ preventScroll: true });
    entry.onSelect();
  };
  const renderEntries = (entries: TitlebarMenuEntry[]) =>
    entries.map((entry) => {
      if ("separator" in entry)
        return <DropdownMenu.Separator key={entry.id} className="collapsed-menu-separator" />;
      const children = (
        <>
          <span className="collapsed-menu-label">{entry.label}</span>
          {entry.shortcut && <span className="collapsed-menu-shortcut">{entry.shortcut}</span>}
          {entry.checked && <Check className="collapsed-menu-check" aria-hidden="true" />}
        </>
      );
      const props = {
        className: "collapsed-menu-item cursor-link",
        disabled: entry.disabled,
        "data-collapsed-leaf": "",
        onSelect: () => selectAction(entry),
      };
      return entry.checked === undefined ? (
        <DropdownMenu.Item key={entry.id} {...props}>
          {children}
        </DropdownMenu.Item>
      ) : (
        <DropdownMenu.CheckboxItem key={entry.id} checked={entry.checked} {...props}>
          {children}
        </DropdownMenu.CheckboxItem>
      );
    });

  return (
    <DropdownMenu.Root open={open} onOpenChange={changeOpen} modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          ref={trigger}
          type="button"
          role="menuitem"
          aria-label={t("menu.bar")}
          className={`collapsed-menu-trigger ${open ? "collapsed-menu-trigger-open" : ""}`}
          onPointerDown={onCapture}
          onKeyDown={(event) => {
            if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) onCapture();
            if (event.key === "ArrowUp") {
              event.preventDefault();
              changeOpen(true);
            }
          }}
        >
          <Ellipsis className="size-[18px]" aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          ref={content}
          className={`collapsed-menu-surface ${drilldown ? "collapsed-menu-drilldown" : "collapsed-menu-categories"}`}
          aria-label={group?.label ?? t("menu.bar")}
          align="start"
          sideOffset={4}
          collisionPadding={8}
          onCloseAutoFocus={(event) => {
            if (!selectedAction.current) return;
            event.preventDefault();
            selectedAction.current = false;
          }}
          onKeyDown={(event) => {
            if (event.key === "Tab") changeOpen(false);
            if (drilldown && activeGroup && event.key === "ArrowLeft") {
              event.preventDefault();
              event.stopPropagation();
              leaveGroup();
            }
          }}
        >
          {drilldown && group ? (
            <>
              <DropdownMenu.Item
                className="collapsed-menu-item collapsed-menu-back cursor-link"
                aria-label={`${t("app.back")} · ${group.label}`}
                onSelect={(event) => {
                  event.preventDefault();
                  leaveGroup();
                }}
              >
                <ChevronLeft aria-hidden="true" />
                <span>{group.label}</span>
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="collapsed-menu-separator" />
              {renderEntries(group.entries)}
            </>
          ) : (
            groups.map((category) =>
              drilldown ? (
                <DropdownMenu.Item
                  key={category.id}
                  className="collapsed-menu-item cursor-link"
                  data-collapsed-category={category.id}
                  aria-haspopup="menu"
                  aria-expanded={false}
                  onSelect={(event) => {
                    event.preventDefault();
                    enterGroup(category.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "ArrowRight") return;
                    event.preventDefault();
                    event.stopPropagation();
                    enterGroup(category.id);
                  }}
                  onPointerMove={(event) => {
                    if (event.pointerType !== "mouse" || hoverTimer.current !== null) return;
                    hoverTimer.current = setTimeout(() => enterGroup(category.id), 250);
                  }}
                  onPointerLeave={clearHover}
                >
                  <span className="collapsed-menu-label">{category.label}</span>
                  <ChevronRight className="collapsed-menu-chevron" aria-hidden="true" />
                </DropdownMenu.Item>
              ) : (
                <DropdownMenu.Sub
                  key={category.id}
                  onOpenChange={(next) => {
                    if (next) onCategoryOpen(category.id);
                  }}
                >
                  <DropdownMenu.SubTrigger className="collapsed-menu-item cursor-link">
                    <span className="collapsed-menu-label">{category.label}</span>
                    <ChevronRight className="collapsed-menu-chevron" aria-hidden="true" />
                  </DropdownMenu.SubTrigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.SubContent
                      className="collapsed-menu-surface collapsed-menu-subcontent"
                      aria-label={category.label}
                      sideOffset={4}
                      collisionPadding={8}
                    >
                      {renderEntries(category.entries)}
                    </DropdownMenu.SubContent>
                  </DropdownMenu.Portal>
                </DropdownMenu.Sub>
              )
            )
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

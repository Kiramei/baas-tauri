import React from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";

import { reloadWithoutPrompt } from "@/shared/reload";
import { useUISetting } from "@/context/UISettingsProvider.tsx";

type MenuState = {
  x: number;
  y: number;
  selectedText: string;
  target: EventTarget | null;
  selectionRange?: Range;
};

const menuClass =
  "fixed z-[9999] w-[208px] max-w-[calc(100vw-16px)] select-none rounded-[8px] border-none bg-[var(--menu-background)] p-[6px] text-foreground shadow-[var(--menu-shadow)] backdrop-blur-xl backdrop-saturate-125";

const itemClass =
  "flex h-7 w-full cursor-default items-center justify-between gap-4 rounded-[4px] px-3 text-left text-[13px] leading-5 outline-none hover:bg-[var(--menu-hover)] focus-visible:bg-[var(--menu-hover)] disabled:pointer-events-none disabled:opacity-40";

const getEditableElement = (target: EventTarget | null): HTMLElement | null => {
  const element = target instanceof HTMLElement ? target : document.activeElement;
  if (!(element instanceof HTMLElement)) return null;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return element.disabled ||
      element.readOnly ||
      (element instanceof HTMLInputElement &&
        /^(button|checkbox|color|file|hidden|image|radio|range|reset|submit)$/.test(element.type))
      ? null
      : element;
  }
  const editable = element.closest<HTMLElement>("[contenteditable=''], [contenteditable='true']");
  if (editable) return editable;
  const active = document.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    return active.disabled || active.readOnly ? null : active;
  }
  if (active instanceof HTMLElement && active.isContentEditable) return active;
  return null;
};

const selectedTextFromEditable = (element: Element | null): string => {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return "";
  const start = element.selectionStart ?? 0;
  const end = element.selectionEnd ?? 0;
  return start === end ? "" : element.value.slice(start, end);
};

const getSelectedText = (target: EventTarget | null): string => {
  const targetText = selectedTextFromEditable(target instanceof Element ? target : null);
  if (targetText) return targetText;
  const activeText = selectedTextFromEditable(document.activeElement);
  if (activeText) return activeText;
  return window.getSelection()?.toString() ?? "";
};

const insertText = (target: EventTarget | null, text: string, range?: Range) => {
  const editable = getEditableElement(target);
  if (!editable || !text) return;

  if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
    const start = editable.selectionStart ?? editable.value.length;
    const end = editable.selectionEnd ?? editable.value.length;

    editable.focus();
    const prototype =
      editable instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    setter?.call(editable, `${editable.value.slice(0, start)}${text}${editable.value.slice(end)}`);
    const nextPosition = start + text.length;
    if (
      !(editable instanceof HTMLInputElement) ||
      /^(text|search|tel|url|password)$/.test(editable.type)
    ) {
      editable.setSelectionRange(nextPosition, nextPosition);
    }
    editable.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: text })
    );
    return;
  }

  editable.focus();
  if (range) {
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
  document.execCommand("insertText", false, text);
};

const openInspector = async (webuiHint: string) => {
  if (__WITH_TAURI__) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_main_devtools");
    return;
  }

  console.info("Use the browser developer tools to inspect this WebUI page.");
  toast.info(webuiHint);
};

const GlobalContextMenu: React.FC = () => {
  const { t } = useTranslation();
  const lowPerformanceMode = useUISetting((settings) => settings.lowPerformanceMode);
  const [menu, setMenu] = React.useState<MenuState | null>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const focusBeforeMenu = React.useRef<HTMLElement | null>(null);

  const close = React.useCallback(() => setMenu(null), []);

  React.useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      if (event.target instanceof Element && event.target.closest("[data-context-menu]")) return;
      const selectedText = getSelectedText(event.target);
      const selection = window.getSelection();
      focusBeforeMenu.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setMenu({
        x: event.clientX + 2,
        y: event.clientY + 2,
        selectedText,
        target: event.target,
        selectionRange: selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : undefined,
      });
    };

    const onPointerDown = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest("[data-context-menu]")) {
        close();
      }
    };

    window.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("blur", close);
    };
  }, [close]);

  React.useLayoutEffect(() => {
    const element = menuRef.current;
    if (!menu || !element) return;
    const { width, height } = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - height - 8))}px`;
    element.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus({ preventScroll: true });
  }, [menu]);

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      close();
      focusBeforeMenu.current?.focus({ preventScroll: true });
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='menuitem']:not(:disabled)")
    );
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus({ preventScroll: true });
  };

  const copySelection = async () => {
    if (!menu?.selectedText) return;
    await navigator.clipboard?.writeText(menu.selectedText);
    close();
    focusBeforeMenu.current?.focus({ preventScroll: true });
  };

  const pasteClipboard = async () => {
    if (!menu) return;
    try {
      const text = await navigator.clipboard?.readText();
      if (text) insertText(menu.target, text, menu.selectionRange);
    } catch {
      toast.error(t("contextMenu.pasteFailed", "Clipboard is not available."));
    }
    close();
  };

  const reloadPage = () => {
    close();
    reloadWithoutPrompt();
  };

  const inspectPage = () => {
    close();
    void openInspector(t("contextMenu.inspectWebuiHint"));
  };

  const canPaste = Boolean(menu && getEditableElement(menu.target));

  return createPortal(
    <AnimatePresence>
      {menu && (
        <motion.div
          data-context-menu
          ref={menuRef}
          role="menu"
          onKeyDown={onMenuKeyDown}
          initial={lowPerformanceMode ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={lowPerformanceMode ? undefined : { opacity: 0 }}
          transition={{ type: "tween", duration: lowPerformanceMode ? 0 : 0.1 }}
          className={menuClass}
          style={{ top: menu.y, left: menu.x }}
        >
          {!!menu.selectedText && (
            <button
              type="button"
              role="menuitem"
              className={itemClass}
              onClick={() => void copySelection()}
            >
              {t("contextMenu.copy")}
              <span className="text-[12px] text-muted-foreground">Ctrl+C</span>
            </button>
          )}
          {canPaste && (
            <button
              type="button"
              role="menuitem"
              className={itemClass}
              onClick={() => void pasteClipboard()}
            >
              {t("contextMenu.paste")}
              <span className="text-[12px] text-muted-foreground">Ctrl+V</span>
            </button>
          )}
          {(!!menu.selectedText || canPaste) && (
            <div role="separator" className="-mx-[6px] my-[6px] h-px bg-[var(--menu-border)]" />
          )}
          <button type="button" role="menuitem" className={itemClass} onClick={reloadPage}>
            {t("contextMenu.reload")}
          </button>
          <button type="button" role="menuitem" className={itemClass} onClick={inspectPage}>
            {t("contextMenu.inspect")}
          </button>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
};

export default GlobalContextMenu;

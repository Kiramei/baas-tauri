import React from "react";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "framer-motion";
import { ClipboardPaste, Copy, RotateCw, SearchCode } from "lucide-react";
import { toast } from "sonner";

import { reloadWithoutPrompt } from "@/shared/reload";
import { useUISetting } from "@/context/UISettingsProvider.tsx";

type MenuState = {
  x: number;
  y: number;
  selectedText: string;
  target: EventTarget | null;
};

const menuClass =
  "fixed z-[9999] min-w-40 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-lg py-1";

const itemClass =
  "w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-45 disabled:pointer-events-none";

/** Returns the get editable element result. */
const getEditableElement = (target: EventTarget | null): HTMLElement | null => {
  const element = target instanceof HTMLElement ? target : document.activeElement;
  if (!(element instanceof HTMLElement)) return null;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element;
  const editable = element.closest<HTMLElement>("[contenteditable=''], [contenteditable='true']");
  if (editable) return editable;
  const active = document.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return active;
  if (active instanceof HTMLElement && active.isContentEditable) return active;
  return null;
};

/** Returns the selected text from editable result. */
const selectedTextFromEditable = (element: Element | null): string => {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return "";
  const start = element.selectionStart ?? 0;
  const end = element.selectionEnd ?? 0;
  return start === end ? "" : element.value.slice(start, end);
};

/** Returns the get selected text result. */
const getSelectedText = (target: EventTarget | null): string => {
  const targetText = selectedTextFromEditable(target instanceof Element ? target : null);
  if (targetText) return targetText;
  const activeText = selectedTextFromEditable(document.activeElement);
  if (activeText) return activeText;
  return window.getSelection()?.toString() ?? "";
};

/** Handles the menu position workflow. */
const menuPosition = (event: MouseEvent) => ({
  x: Math.max(8, Math.min(event.clientX + 2, window.innerWidth - 170)),
  y: Math.max(8, Math.min(event.clientY + 2, window.innerHeight - 178)),
});

/** Handles the insert text workflow. */
const insertText = (target: EventTarget | null, text: string) => {
  const editable = getEditableElement(target);
  if (!editable || !text) return;

  if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
    const start = editable.selectionStart ?? editable.value.length;
    const end = editable.selectionEnd ?? editable.value.length;

    editable.value = `${editable.value.slice(0, start)}${text}${editable.value.slice(end)}`;
    const nextPosition = start + text.length;
    editable.setSelectionRange(nextPosition, nextPosition);
    editable.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }

  editable.focus();
  document.execCommand("insertText", false, text);
};

/** Performs the open inspector operation. */
const openInspector = async (webuiHint: string) => {
  if (__WITH_TAURI__) {
    const { invoke } = await import("@/shared/TauriInvoke");
    await invoke("open_main_devtools");
    return;
  }

  console.info("Use the browser developer tools to inspect this WebUI page.");
  toast.info(webuiHint);
};

/** Renders the global context menu component. */
const GlobalContextMenu: React.FC = () => {
  const { t } = useTranslation();
  const lowPerformanceMode = useUISetting((settings) => settings.lowPerformanceMode);
  const [menu, setMenu] = React.useState<MenuState | null>(null);

  /** Performs the close operation. */
  const close = React.useCallback(() => setMenu(null), []);

  React.useEffect(() => {
    /** Handles the on context menu interaction. */
    const onContextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      const selectedText = getSelectedText(event.target);
      const position = menuPosition(event);
      setMenu({
        x: position.x,
        y: position.y,
        selectedText,
        target: event.target,
      });
    };

    /** Handles the on pointer down interaction. */
    const onPointerDown = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest("[data-context-menu]")) {
        close();
      }
    };
    /** Handles the on key down interaction. */
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };

    window.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", close);
    };
  }, [close]);

  /** Handles the copy selection workflow. */
  const copySelection = async () => {
    if (!menu?.selectedText) return;
    await navigator.clipboard?.writeText(menu.selectedText);
    close();
  };

  /** Handles the paste clipboard workflow. */
  const pasteClipboard = async () => {
    if (!menu) return;
    try {
      const text = await navigator.clipboard?.readText();
      if (text) insertText(menu.target, text);
    } catch {
      toast.error(t("contextMenu.pasteFailed", "Clipboard is not available."));
    }
    close();
  };

  /** Handles the reload page workflow. */
  const reloadPage = () => {
    close();
    reloadWithoutPrompt();
  };

  /** Handles the inspect page workflow. */
  const inspectPage = () => {
    close();
    void openInspector(t("contextMenu.inspectWebuiHint"));
  };

  const canPaste = Boolean(menu && getEditableElement(menu.target));

  return (
    <AnimatePresence>
      {menu && (
        <motion.div
          data-context-menu
          initial={lowPerformanceMode ? false : { opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={lowPerformanceMode ? undefined : { opacity: 0, scale: 0.96 }}
          transition={{ type: "tween", duration: lowPerformanceMode ? 0 : 0.12 }}
          className={menuClass}
          style={{ top: menu.y, left: menu.x }}
        >
          <button className={itemClass} onClick={reloadPage}>
            <RotateCw className="w-4 h-4" />
            {t("contextMenu.reload")}
          </button>
          <button className={itemClass} disabled={!menu.selectedText} onClick={copySelection}>
            <Copy className="w-4 h-4" />
            {t("contextMenu.copy")}
          </button>
          <button className={itemClass} disabled={!canPaste} onClick={() => void pasteClipboard()}>
            <ClipboardPaste className="w-4 h-4" />
            {t("contextMenu.paste")}
          </button>
          <button className={itemClass} onClick={inspectPage}>
            <SearchCode className="w-4 h-4" />
            {t("contextMenu.inspect")}
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default GlobalContextMenu;

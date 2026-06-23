import React from "react";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "framer-motion";
import { ClipboardPaste, Copy, RotateCw, SearchCode } from "lucide-react";
import { toast } from "sonner";

import { reloadWithoutPrompt } from "@/shared/reload";

type MenuState = {
  x: number;
  y: number;
  selectedText: string;
  clipboardText: string;
  target: EventTarget | null;
};

const menuClass =
  "fixed z-[9999] min-w-40 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-lg py-1";

const itemClass =
  "w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-45 disabled:pointer-events-none";

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

const readClipboardText = async (): Promise<string> => {
  try {
    if (!navigator.clipboard?.readText) return "";
    return await navigator.clipboard.readText();
  } catch {
    return "";
  }
};

const menuPosition = (event: MouseEvent) => ({
  x: Math.max(8, Math.min(event.clientX + 2, window.innerWidth - 170)),
  y: Math.max(8, Math.min(event.clientY + 2, window.innerHeight - 178)),
});

const insertText = (target: EventTarget | null, text: string) => {
  const editable = getEditableElement(target);
  if (!editable || !text) return;

  if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
    const start = editable.selectionStart ?? editable.value.length;
    const end = editable.selectionEnd ?? editable.value.length;
    const nextValue = `${editable.value.slice(0, start)}${text}${editable.value.slice(end)}`;
    editable.value = nextValue;
    const nextPosition = start + text.length;
    editable.setSelectionRange(nextPosition, nextPosition);
    editable.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }

  editable.focus();
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
  const [menu, setMenu] = React.useState<MenuState | null>(null);

  const close = React.useCallback(() => setMenu(null), []);

  React.useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      const selectedText = getSelectedText(event.target);
      const position = menuPosition(event);
      setMenu({
        x: position.x,
        y: position.y,
        selectedText,
        clipboardText: "",
        target: event.target,
      });
      void readClipboardText().then((clipboardText) => {
        setMenu((current) =>
          current && current.x === position.x && current.y === position.y
            ? { ...current, clipboardText }
            : current
        );
      });
    };

    const onPointerDown = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest("[data-context-menu]")) {
        close();
      }
    };
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

  const copySelection = async () => {
    if (!menu?.selectedText) return;
    await navigator.clipboard?.writeText(menu.selectedText);
    close();
  };

  const pasteClipboard = () => {
    if (!menu?.clipboardText) return;
    insertText(menu.target, menu.clipboardText);
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

  return (
    <AnimatePresence>
      {menu && (
        <motion.div
          data-context-menu
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.96 }}
          transition={{ type: "tween", duration: 0.12 }}
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
          <button className={itemClass} disabled={!menu.clipboardText} onClick={pasteClipboard}>
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

import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { motion } from "framer-motion";
import { useUISetting } from "@/context/UISettingsProvider.tsx";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  titleNode?: React.ReactNode;
  width?: number;
  fullscreen?: boolean;
}

/** Keep keyboard focus in the active dialog and restore its opener when it closes. */
export const useModalFocus = (
  isOpen: boolean,
  ref: React.RefObject<HTMLDivElement | null>,
  onClose: () => void
) => {
  const onCloseRef = React.useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    if (!isOpen) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusables = () =>
      Array.from(
        ref.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])"
        ) ?? []
      ).filter((element) => element.getClientRects().length > 0);
    const frame = requestAnimationFrame(() => {
      (
        ref.current?.querySelector<HTMLElement>("[data-autofocus]") ??
        focusables()[0] ??
        ref.current
      )?.focus({ preventScroll: true });
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (
        document.activeElement instanceof Element &&
        document.activeElement.closest("[role='listbox'], [role='menu']")
      )
        return;
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (!items.length) {
        event.preventDefault();
        ref.current?.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (
        event.shiftKey &&
        (document.activeElement === first || !ref.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !ref.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", handleKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [isOpen, ref]);
};

/** Renders the modal component. */
export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  children,
  titleNode = undefined,
  width = 40,
  fullscreen = false,
}) => {
  const { t } = useTranslation();
  const lowPerformanceMode = useUISetting((settings) => settings.lowPerformanceMode);
  const zoomScale = useUISetting((settings) => settings.zoomScale);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();
  useModalFocus(isOpen, panelRef, onClose);

  if (!isOpen) return null;

  const overlayCls = `fixed inset-0 z-[1100] flex items-center justify-center bg-black/35 ${
    fullscreen ? "p-0" : "p-4"
  }`;

  return createPortal(
    <div
      className={overlayCls}
      style={{
        paddingTop: fullscreen
          ? "var(--window-titlebar-height, 0px)"
          : "calc(var(--window-titlebar-height, 0px) + 1rem)",
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={titleNode ? title : undefined}
        aria-labelledby={titleNode ? undefined : titleId}
        tabIndex={-1}
        initial={lowPerformanceMode ? false : { opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={lowPerformanceMode ? undefined : { opacity: 0, y: 4 }}
        transition={{ duration: lowPerformanceMode ? 0 : 0.14 }}
        className={
          fullscreen
            ? "flex h-full w-full flex-col overflow-hidden bg-background text-foreground"
            : "rounded-xl border border-[var(--menu-border)] bg-popover p-6 text-popover-foreground shadow-[var(--menu-shadow)]"
        }
        style={
          fullscreen
            ? undefined
            : {
                width: `${width}%`,
                minWidth: "min(320px, 100%)",
                maxWidth: "100%",
                zoom: zoomScale / 100,
              }
        }
      >
        <div
          className={fullscreen ? "flex h-full min-h-0 flex-col" : "overflow-auto"}
          style={
            fullscreen
              ? undefined
              : { maxHeight: "calc(100vh - var(--window-titlebar-height, 0px) - 80px)" }
          }
        >
          <div
            className={`flex shrink-0 items-center justify-between gap-4 ${
              fullscreen ? "h-[52px] border-b border-border px-4" : "pb-4"
            }`}
          >
            {titleNode ? (
              titleNode
            ) : (
              <h2 id={titleId} className="text-[16px] font-medium leading-6 text-foreground">
                {title}
              </h2>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label={t("common.close")}
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <X className="size-4" />
            </button>
          </div>
          <div className={fullscreen ? "min-h-0 flex-1 overflow-hidden" : "overflow-y-auto"}>
            {children}
          </div>
        </div>
      </motion.div>
    </div>,
    document.body
  );
};

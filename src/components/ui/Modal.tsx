import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import { useAppTranslation as useTranslation } from "@/shared/useAppTranslation";
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
      data-modal-backdrop=""
      className={overlayCls}
      style={{
        ...(__WITH_ANDROID__
          ? {
              top: "var(--android-viewport-top, 0px)",
              left: "var(--android-viewport-left, 0px)",
              right: "auto",
              bottom: "auto",
              width: "var(--android-viewport-width, 100vw)",
              height: "var(--android-viewport-height, 100dvh)",
              padding: fullscreen ? 0 : 12,
            }
          : {}),
        paddingTop: fullscreen
          ? "var(--window-titlebar-height, 0px)"
          : __WITH_ANDROID__
            ? "max(12px, env(safe-area-inset-top, 0px))"
            : "calc(var(--window-titlebar-height, 0px) + 1rem)",
        ...(__WITH_ANDROID__ && !fullscreen
          ? { paddingBottom: "max(12px, env(safe-area-inset-bottom, 0px))" }
          : {}),
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
            : "modal-surface"
        }
        style={
          fullscreen
            ? undefined
            : {
                width: __WITH_ANDROID__ ? "100%" : `${width}%`,
                minWidth: "min(320px, 100%)",
                maxWidth: __WITH_ANDROID__ ? "min(640px, 100%)" : "100%",
                zoom: __WITH_ANDROID__ ? 1 : zoomScale / 100,
              }
        }
      >
        <div
          className={fullscreen ? "flex h-full min-h-0 flex-col" : "overflow-auto"}
          style={
            fullscreen
              ? undefined
              : {
                  maxHeight: __WITH_ANDROID__
                    ? "calc(var(--android-viewport-height, 100dvh) - 64px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px))"
                    : "calc(100vh - var(--window-titlebar-height, 0px) - 80px)",
                  ...(__WITH_ANDROID__ ? { overscrollBehavior: "contain" } : {}),
                }
          }
        >
          <div
            className={
              fullscreen
                ? "flex h-[52px] shrink-0 items-center justify-between gap-4 border-b border-border px-4"
                : "modal-header"
            }
          >
            {titleNode ? (
              titleNode
            ) : (
              <h2 id={titleId} className="modal-title">
                {title}
              </h2>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label={t("common.close")}
              className="modal-close"
              style={__WITH_ANDROID__ ? { width: 44, height: 44, flexBasis: 44 } : undefined}
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

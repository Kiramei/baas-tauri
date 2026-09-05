import React, { useEffect } from "react";
import { createPortal } from "react-dom";
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
  const lowPerformanceMode = useUISetting((settings) => settings.lowPerformanceMode);

  useEffect(() => {
    if (!isOpen) return;
    /** Handles the handle esc interaction. */
    const handleEsc = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleEsc);
    return () => {
      window.removeEventListener("keydown", handleEsc);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const overlayCls = `fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm ${
    fullscreen ? "p-0" : "p-4"
  }`;

  return createPortal(
    <div
      className={overlayCls}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <motion.div
        initial={lowPerformanceMode ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={lowPerformanceMode ? undefined : { opacity: 0, y: 8 }}
        transition={{ duration: lowPerformanceMode ? 0 : 0.16 }}
        className={
          fullscreen
            ? "flex h-full w-full flex-col overflow-hidden bg-white dark:bg-slate-900"
            : "rounded-xl border border-slate-200 bg-white p-5 px-3 shadow-xl dark:border-slate-700 dark:bg-slate-900"
        }
        style={
          fullscreen
            ? undefined
            : { width: `${width}%`, minWidth: "min(320px, 100%)", maxWidth: "100%" }
        }
      >
        <div
          className={fullscreen ? "flex h-full min-h-0 flex-col" : "overflow-auto px-2"}
          style={fullscreen ? undefined : { maxHeight: "calc(100vh - 80px)" }}
        >
          <div
            className={`flex shrink-0 items-center justify-between border-b border-slate-200 dark:border-slate-700 ${
              fullscreen ? "h-[52px] px-4" : "p-0"
            }`}
          >
            {titleNode ? (
              titleNode
            ) : (
              <h2 className="text-xl font-semibold text-slate-800 dark:text-slate-100">{title}</h2>
            )}
            <button
              onClick={onClose}
              className="p-1 rounded-full hover:bg-slate-100 dark:hover:bg-slate-700"
            >
              <X className="w-5 h-5 text-slate-500" />
            </button>
          </div>
          <div
            className={fullscreen ? "min-h-0 flex-1 overflow-hidden" : "overflow-y-auto px-1 py-2"}
          >
            {children}
          </div>
        </div>
      </motion.div>
    </div>,
    document.body
  );
};

import { useEffect, useState } from "react";
import { EditActionsController } from "@/shared/EditActions";

/** Track editor focus/selection without intercepting native text-editing shortcuts. */
export function useEditActions() {
  const [controller] = useState(() => new EditActionsController({ document }));
  useEffect(() => {
    const remember = () => controller.rememberTarget();
    const leaving = (event: FocusEvent) => {
      if (event.target === document.activeElement) controller.rememberTarget();
    };
    document.addEventListener("focusin", remember);
    document.addEventListener("focusout", leaving);
    document.addEventListener("selectionchange", remember);
    document.addEventListener("input", remember);
    document.addEventListener("select", remember, true);
    controller.rememberTarget();
    return () => {
      document.removeEventListener("focusin", remember);
      document.removeEventListener("focusout", leaving);
      document.removeEventListener("selectionchange", remember);
      document.removeEventListener("input", remember);
      document.removeEventListener("select", remember, true);
    };
  }, [controller]);
  return controller;
}

import React, { ReactNode } from "react";
import { t } from "i18next";
import { cn } from "@/shared/cn";

interface SwitchButtonProps {
  checked: boolean;
  label?: string; // Button label text.
  onChange: (checked: boolean) => void; // State toggle callback.
  className?: string;
  children?: ReactNode;
  disabled?: boolean;
  iconOnly?: boolean;
}

/** Renders the switch button component. */
const SwitchButton: React.FC<SwitchButtonProps> = ({
  children,
  checked,
  label,
  onChange,
  className = "",
  disabled = false,
  iconOnly,
  ...props
}) => {
  const fixedSquare =
    /\bsize-\d+/.test(className) || (/\bw-\d+/.test(className) && /\bh-\d+/.test(className));
  const isIconOnly = iconOnly ?? fixedSquare;
  const baseClasses = cn(
    "inline-flex items-center justify-center rounded-lg text-sm font-semibold transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed",
    isIconOnly ? "p-0 shrink-0 [&>svg]:h-4 [&>svg]:w-4 [&>svg]:shrink-0" : "px-6 py-2"
  );
  const stateClasses = checked
    ? "bg-primary-600 text-white hover:bg-primary-700 focus:ring-primary-500"
    : "bg-slate-200 text-slate-800 hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600 focus:ring-slate-500";

  return children ? (
    <button
      onClick={() => onChange(!checked)}
      className={cn(baseClasses, stateClasses, className)}
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  ) : (
    <button
      onClick={() => onChange(!checked)}
      className={cn(baseClasses, stateClasses, className)}
      disabled={disabled}
      {...props}
    >
      {label ?? ""} : {checked ? t("switch.on") : t("switch.off")}
    </button>
  );
};

export default SwitchButton;

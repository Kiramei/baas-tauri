import React, { ReactNode } from "react";
import { t } from "i18next";
import { cn } from "@/shared/cn";

interface SwitchButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
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
    "inline-flex items-center justify-center rounded-lg border border-transparent text-sm font-medium outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-40 disabled:cursor-not-allowed",
    isIconOnly ? "p-0 shrink-0 [&>svg]:h-4 [&>svg]:w-4 [&>svg]:shrink-0" : "px-6 py-2"
  );
  const stateClasses = checked
    ? "bg-primary text-primary-foreground hover:bg-primary/90"
    : "border-input bg-transparent text-foreground hover:bg-secondary";

  return children ? (
    <button
      aria-pressed={checked}
      onClick={() => onChange(!checked)}
      className={cn(baseClasses, stateClasses, className)}
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  ) : (
    <button
      aria-pressed={checked}
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

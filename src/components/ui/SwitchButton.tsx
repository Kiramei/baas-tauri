import React, { ReactNode } from "react";
import { cn } from "@/shared/cn";
import "./control-switch.css";

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

  if (!children && !isIconOnly) {
    return (
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          "inline-flex min-h-11 min-w-0 items-center justify-between gap-4 rounded-lg border border-border bg-transparent px-3 py-2 text-left text-sm font-medium text-foreground outline-none transition-colors duration-150 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40",
          className
        )}
        disabled={disabled}
        {...props}
      >
        <span className="min-w-0">{label}</span>
        <span aria-hidden="true" className="control-switch" data-checked={checked}>
          <span className="control-switch-thumb" />
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      aria-pressed={checked}
      onClick={() => onChange(!checked)}
      className={cn(baseClasses, stateClasses, className)}
      disabled={disabled}
      {...props}
    >
      {children ?? label}
    </button>
  );
};

export default SwitchButton;

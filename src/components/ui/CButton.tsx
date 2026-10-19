import React from "react";
import { cn } from "@/shared/cn";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
  variant?: "primary" | "secondary" | "danger";
  className?: string;
  iconOnly?: boolean;
}

/** Renders the cbutton component. */
const CButton: React.FC<ButtonProps> = ({
  children,
  variant = "primary",
  className = "",
  iconOnly,
  ...props
}) => {
  const fixedSquare =
    /\bsize-\d+/.test(className) || (/\bw-\d+/.test(className) && /\bh-\d+/.test(className));
  const isIconOnly = iconOnly ?? fixedSquare;
  const baseClasses = cn(
    "inline-flex items-center justify-center gap-2 rounded-[8px] border border-transparent text-sm font-medium outline-none transition-[background-color,color,border-color] duration-150 active:brightness-95 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-40 disabled:cursor-not-allowed",
    isIconOnly ? "p-0 shrink-0 [&>svg]:h-4 [&>svg]:w-4 [&>svg]:shrink-0" : "px-4 py-2"
  );

  const variantClasses = {
    primary: "bg-primary text-primary-foreground hover:bg-primary/90",
    secondary: "border-input bg-transparent text-foreground hover:bg-secondary",
    danger: "bg-destructive text-white hover:bg-destructive/90",
  };

  return (
    <button
      data-variant={variant}
      className={cn(baseClasses, variantClasses[variant], className)}
      {...props}
    >
      {children}
    </button>
  );
};

export default CButton;

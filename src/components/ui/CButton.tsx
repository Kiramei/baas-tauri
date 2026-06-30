import React from "react";
import { cn } from "@/shared/GlobalUtilities";

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
    "inline-flex items-center justify-center gap-2 text-sm font-semibold rounded-lg shadow-sm focus:outline-none transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed",
    isIconOnly ? "p-0 shrink-0 [&>svg]:h-4 [&>svg]:w-4 [&>svg]:shrink-0" : "px-4 py-2"
  );

  const variantClasses = {
    primary: "bg-primary-600 text-white hover:bg-primary-700 focus:ring-primary-500",
    secondary:
      "bg-slate-200 text-slate-800 hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600 focus:ring-slate-500",
    danger: "bg-red-600 text-white hover:bg-red-700 focus:ring-red-500",
  };

  return (
    <button className={cn(baseClasses, variantClasses[variant], className)} {...props}>
      {children}
    </button>
  );
};

export default CButton;

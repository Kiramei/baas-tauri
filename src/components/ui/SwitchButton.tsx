import React, { ReactNode } from "react";
import { t } from "i18next";

interface SwitchButtonProps {
  checked: boolean;
  label?: string; // Button label text.
  onChange: (checked: boolean) => void; // State toggle callback.
  className?: string;
  children?: ReactNode;
  disabled?: boolean;
}

const SwitchButton: React.FC<SwitchButtonProps> = ({
  children,
  checked,
  label,
  onChange,
  className = "",
  disabled = false,
  ...props
}) => {
  return children ? (
    <button
      onClick={() => onChange(!checked)}
      className={`px-6 py-2 rounded-lg text-sm font-semibold transition-all duration-200 ${
        checked
          ? "bg-primary-600 text-white hover:bg-primary-700 focus:ring-primary-500"
          : "bg-slate-200 text-slate-800 hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600 focus:ring-slate-500"
      } ${className}`}
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  ) : (
    <button
      onClick={() => onChange(!checked)}
      className={`px-6 py-2 rounded-lg text-sm font-semibold transition-all duration-200 ${
        checked
          ? "bg-primary-600 text-white hover:bg-primary-700 focus:ring-primary-500"
          : "bg-slate-200 text-slate-800 hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600 focus:ring-slate-500"
      } ${className}`}
      {...props}
    >
      {label ?? ""} : {checked ? t("switch.on") : t("switch.off")}
    </button>
  );
};

export default SwitchButton;

"use client";

import * as React from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import { LabelWithTooltip } from "@/components/ui/LabelWithTooltip.tsx";
import { useGlobalSelect } from "@/components/ui/SelectGlobal.tsx";

interface Option {
  value: string;
  label: string;
  disabled?: boolean;
}

interface FormSelectProps {
  label?: string;
  tooltip?: string;
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  placeholder?: string;
  className?: string;
  selectId?: string;
  disabled?: boolean;
  ariaLabel?: string;
}

/** Renders the form select component. */
export const FormSelect: React.FC<FormSelectProps> = ({
  label,
  tooltip,
  value,
  onChange,
  options,
  placeholder,
  className,
  selectId,
  disabled = false,
  ariaLabel,
}) => {
  const autoId = React.useId();
  const id = selectId ?? autoId;
  const global = useGlobalSelect();

  const open = global ? global.openId === id : undefined;
  /** Handles the handle open change interaction. */
  const handleOpenChange = (next: boolean) => {
    if (!global) return;
    global.setOpenId(next ? id : null);
  };

  return (
    <div className={`space-y-2 ${className ?? ""}`}>
      {label &&
        (tooltip ? (
          <LabelWithTooltip className="block text-sm font-medium" label={label} tooltip={tooltip} />
        ) : (
          <label className="block text-sm font-medium">{label}</label>
        ))}

      <Select
        value={value}
        disabled={disabled}
        onValueChange={(v) => {
          onChange(v);
          if (global) global.setOpenId(null);
        }}
        {...(global && { open, onOpenChange: handleOpenChange })}
      >
        <SelectTrigger
          className="w-full min-w-0"
          aria-label={ariaLabel}
          title={options.find((option) => option.value === value)?.label}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>

        <SelectContent position="popper">
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value} disabled={opt.disabled}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
};

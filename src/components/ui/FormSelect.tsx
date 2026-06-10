"use client";

import * as React from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./Select";
import { LabelWithTooltip } from "@/components/ui/LabelWithTooltip.tsx";
import { useGlobalSelect } from "./SelectGlobal.tsx"; // ⬅️ 新增

interface Option {
  value: string;
  label: string;
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
}

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
}) => {
  const autoId = React.useId();
  const id = selectId ?? autoId;
  const global = useGlobalSelect();

  const open = global ? global.openId === id : undefined;
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
        <SelectTrigger className="w-full">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>

        <SelectContent position="popper">
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
};

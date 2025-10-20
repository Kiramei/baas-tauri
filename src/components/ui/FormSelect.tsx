"use client";

import * as React from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {LabelWithTooltip} from "@/components/ui/LabelWithTooltip.tsx";
import {useGlobalSelect} from "@/components/ui/select-global.tsx"; // ⬅️ 新增

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
  /** 同一 SelectGroup 内要唯一，用于互斥控制；不传则自动生成 */
  selectId?: string;
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
                                                      }) => {
  const autoId = React.useId()
  const id = selectId ?? autoId
  const global = useGlobalSelect()

  const open = global ? global.openId === id : undefined
  const handleOpenChange = (next: boolean) => {
    if (!global) return
    global.setOpenId(next ? id : null)
  }

  return (
    <div className={`space-y-2 ${className ?? ""}`}>
      {label &&
        (tooltip ? (
          <LabelWithTooltip
            className="block text-sm font-medium"
            label={label}
            tooltip={tooltip}
          />
        ) : (
          <label className="block text-sm font-medium">{label}</label>
        ))}

      <Select
        value={value}
        onValueChange={(v) => {
          onChange(v)
          if (global) global.setOpenId(null)
        }}
        {...(global && {open, onOpenChange: handleOpenChange})}
      >
        <SelectTrigger className="w-full">
          <SelectValue placeholder={placeholder ?? "请选择"}/>
        </SelectTrigger>

        {/* 用 popper，避免内容层遮挡触发器；modal=false 避免事件被阻断 */}
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

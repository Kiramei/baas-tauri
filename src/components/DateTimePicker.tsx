"use client";

import * as React from "react";
import {startTransition} from "react";
import {Calendar} from "@/components/ui/calendar";
import {Popover, PopoverContent, PopoverTrigger} from "@/components/ui/popover";
import {FormInput} from "@/components/ui/FormInput";
import {cn} from "@/lib/utils";
import {toast} from "sonner";
import {useTranslation} from "react-i18next";

interface DateTimePickerProps {
  /**
   * Unix timestamp expressed in milliseconds.
   */
  value: number | null;
  /**
   * Callback invoked whenever the user confirms a new timestamp.
   */
  onChange: (ts: number | null) => void;
  className?: string;
  /**
   * Debounce duration for time input updates (milliseconds).
   */
  delay?: number;
}

const DateTimePickerBase: React.FC<DateTimePickerProps> = ({
  value,
  onChange,
  className,
  delay = 500
}) => {
  const [open, setOpen] = React.useState(false);
  const dateObj = value != null ? new Date(value) : null;
  const {t} = useTranslation();

  // Pre-format date and time strings so the inputs remain controlled even with null values.
  const dateStr = dateObj
    ? `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, "0")}-${String(
      dateObj.getDate()
    ).padStart(2, "0")}`
    : "0000-00-00";

  const timeStr = dateObj
    ? `${String(dateObj.getHours()).padStart(2, "0")}:${String(dateObj.getMinutes()).padStart(
      2,
      "0"
    )}:${String(dateObj.getSeconds()).padStart(2, "0")}`
    : "00:00:00";

  // Maintain the time input locally so we can debounce the write-back.
  const [localTime, setLocalTime] = React.useState(timeStr);

  React.useEffect(() => {
    if (dateObj) {
      setLocalTime(
        `${String(dateObj.getHours()).padStart(2, "0")}:${String(
          dateObj.getMinutes()
        ).padStart(2, "0")}:${String(dateObj.getSeconds()).padStart(2, "0")}`
      );
    }
  }, [value]);

  // Shared timeout handle for debounced time updates.
  const timeoutRef = React.useRef<NodeJS.Timeout | null>(null);

  const handleDateSelect = React.useCallback((selected?: Date) => {
    if (!selected) {
      onChange(null);
      return;
    }

    const newDate = dateObj ?? new Date();
    newDate.setFullYear(selected.getFullYear(), selected.getMonth(), selected.getDate());
    startTransition(() => {
      onChange(newDate.getTime());
      setOpen(false);
    });
    toast(t("toast.dateUpdated"), {
      description: newDate.toLocaleString()
    });
  }, [dateObj, onChange, t]);

  const handleTimeInput = React.useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const val = event.target.value;
    setLocalTime(val);

    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      const [h, m, s] = val.split(":").map((piece) => parseInt(piece, 10));
      const newDate = dateObj ?? new Date();
      newDate.setHours(h || 0, m || 0, s || 0);

      startTransition(() => {
        onChange(newDate.getTime());
      });

      toast.success(t("toast.timeUpdated"), {
        description: newDate.toLocaleString()
      });
    }, delay);
  }, [dateObj, delay, onChange, t]);

  return (
    <div
      className={cn(
        "flex bg-transparent border px-4 rounded-lg py-0 w-fit h-8",
        className
      )}
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <FormInput
            value={dateStr}
            className="justify-between font-mono !p-0"
            childClassName="border-none !p-0 !bg-transparent shadow-none h-8"
          />
        </PopoverTrigger>
        <PopoverContent className="w-auto overflow-hidden p-0" align="start">
          <Calendar
            mode="single"
            selected={dateObj ?? undefined}
            captionLayout="label"
            onSelect={handleDateSelect}
          />
        </PopoverContent>
      </Popover>

      <span className="mx-1 h-8">.</span>

      <FormInput
        type="time"
        step="1"
        value={localTime}
        onChange={handleTimeInput}
        className="font-mono h-8"
        childClassName="h-8
          border-none !p-0 !bg-transparent shadow-none
          focus:outline-none focus-visible:outline-none
          focus-visible:!ring-0 focus-visible:!ring-offset-0
          focus-visible:!border-current
          focus-visible:[--tw-ring-color:transparent]
          focus-visible:[--tw-ring-shadow:0_0_#0000]
          focus-visible:[--tw-ring-offset-shadow:0_0_#0000]
        "
      />
    </div>
  );
};

export const DateTimePicker = React.memo(DateTimePickerBase);

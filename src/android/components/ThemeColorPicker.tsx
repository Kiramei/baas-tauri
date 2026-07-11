import React from "react";
import { RotateCcw } from "lucide-react";
import CButton from "@/components/ui/CButton.tsx";
import { FormInput } from "@/components/ui/FormInput.tsx";
import {
  ColorPicker,
  ColorPickerArea,
  ColorPickerContent,
  ColorPickerEyeDropper,
  ColorPickerHueSlider,
  ColorPickerInput,
  ColorPickerSwatch,
  ColorPickerTrigger,
} from "@/components/ui/ColorPicker";

type ThemeColorPickerProps = {
  pickerValue: string;
  inputValue: string;
  currentColor: string;
  defaultColor: string;
  presets: string[];
  label: string;
  resetLabel: string;
  onInputChange: (value: string) => void;
  onCommit: (value: string) => void;
};

/** Renders the theme color picker control. */
const ThemeColorPicker: React.FC<ThemeColorPickerProps> = ({
  pickerValue,
  inputValue,
  currentColor,
  defaultColor,
  presets,
  label,
  resetLabel,
  onInputChange,
  onCommit,
}) => (
  <div className="grid grid-cols-1 sm:grid-cols-[auto_1fr_auto] gap-3 items-center">
    <ColorPicker value={pickerValue} onValueChange={onCommit}>
      <ColorPickerTrigger asChild>
        <button
          type="button"
          className="flex h-11 w-full items-center justify-center rounded-lg border border-slate-200 bg-white shadow-xs transition hover:border-primary-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 dark:border-slate-700 dark:bg-slate-800 sm:w-14"
          title={label}
          aria-label={label}
        >
          <ColorPickerSwatch className="h-7 w-7 rounded-full border-white ring-1 ring-slate-300 dark:ring-slate-600" />
        </button>
      </ColorPickerTrigger>
      <ColorPickerContent
        align="start"
        className="w-80 rounded-xl border border-slate-200 bg-white p-3 shadow-xl dark:border-slate-700 dark:bg-slate-900"
      >
        <ColorPickerArea className="h-40 rounded-lg" />
        <ColorPickerHueSlider />
        <div className="flex items-center gap-2">
          <ColorPickerInput withoutAlpha className="min-w-0 flex-1" />
          <ColorPickerEyeDropper />
        </div>

        <div className="grid grid-cols-8 gap-2">
          {presets.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={color}
              title={color}
              onClick={() => onCommit(color)}
              className={`h-7 w-7 rounded-full border-2 shadow-xs transition hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 ${
                currentColor.toLowerCase() === color
                  ? "border-slate-900 ring-2 ring-primary-300 dark:border-white"
                  : "border-white dark:border-slate-700"
              }`}
              style={{ backgroundColor: color }}
            />
          ))}
        </div>
      </ColorPickerContent>
    </ColorPicker>
    <FormInput
      className="min-w-0"
      childClassName="font-mono uppercase tracking-wide"
      value={inputValue}
      placeholder={defaultColor}
      onChange={(event) => onInputChange(event.target.value)}
      onBlur={(event) => onCommit(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }
      }}
    />
    <CButton
      type="button"
      variant="secondary"
      className="pl-3"
      onClick={() => onCommit(defaultColor)}
    >
      <div className="flex items-center justify-center">
        <RotateCcw className="mr-1 h-4 w-4" />
        {resetLabel}
      </div>
    </CButton>
  </div>
);

export default ThemeColorPicker;

import React from "react";
import { RotateCcw } from "lucide-react";
import CButton from "@/components/ui/CButton.tsx";
import { FormInput } from "@/components/ui/FormInput.tsx";
import { IconTooltip } from "@/components/ui/Tooltip";
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
      <IconTooltip content={label}>
        <ColorPickerTrigger asChild>
          <button
            type="button"
            className="flex h-9 w-full items-center justify-center rounded-lg border border-border bg-background transition hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-12"
            aria-label={label}
          >
            <ColorPickerSwatch className="h-7 w-7 rounded-full border-white ring-1 ring-slate-300 dark:ring-slate-600" />
          </button>
        </ColorPickerTrigger>
      </IconTooltip>
      <ColorPickerContent align="start" className="w-80 rounded-xl bg-popover p-3 shadow-lg">
        <ColorPickerArea className="h-40 rounded-lg" />
        <ColorPickerHueSlider />
        <div className="flex items-center gap-2">
          <ColorPickerInput withoutAlpha className="min-w-0 flex-1" />
          <ColorPickerEyeDropper />
        </div>

        <div className="grid grid-cols-8 gap-2">
          {presets.map((color) => (
            <IconTooltip key={color} content={color}>
              <button
                type="button"
                aria-label={color}
                onClick={() => onCommit(color)}
                className={`h-7 w-7 rounded-full border-2 shadow-xs transition hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  currentColor.toLowerCase() === color
                    ? "border-foreground ring-2 ring-foreground/20"
                    : "border-background"
                }`}
                style={{ backgroundColor: color }}
              />
            </IconTooltip>
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

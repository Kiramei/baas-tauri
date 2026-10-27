import { Reorder } from "framer-motion";
import { Plus, X } from "lucide-react";
import React, { useDeferredValue, useMemo, useState } from "react";
import { cn } from "@/shared/cn";
import { Dialog, DialogPanel, DialogTitle } from "@headlessui/react";
import { useAppTranslation as useTranslation } from "@/shared/useAppTranslation";
import { LabelWithTooltip } from "@/components/ui/LabelWithTooltip.tsx";
import { FormInput } from "@/components/ui/FormInput.tsx";
import { SearchInput } from "@/components/ui/SearchInput";
import { eventNameKey } from "@/shared/I18nKeys";
import { useUISetting } from "@/context/UISettingsProvider.tsx";

interface MultiSelectorProps {
  label?: string;
  tooltip?: string;
  values: any[];
  onChange: (newValues: any[]) => void;
  className?: string;
  alternatives: any[];
  translatePrefix?: string;
}

interface SelectorModalProps {
  isOpen: boolean;
  onClose: () => void;
  alternatives: any[];
  selected: string[];
  onChange: (list: string[]) => void;
  lang?: "CN" | "JP" | "Global";
  mode?: "single" | "multiple";
  translatePrefix?: string;
}

interface BaseTimeProps {
  label?: string;
  tooltip?: string;
  className?: string;
}

interface TimeModeProps extends BaseTimeProps {
  mode?: "time";
  values: number[][];
  onChange: (list: number[][]) => void;
}

interface RangeModeProps extends BaseTimeProps {
  mode: "range";
  values: number[][][];
  onChange: (list: number[][][]) => void;
}

/** Renders the selector modal component. */
const SelectorModal: React.FC<SelectorModalProps> = ({
  isOpen,
  onClose,
  alternatives,
  selected,
  onChange,
  translatePrefix,
}) => {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const translateName = (name: string) =>
    translatePrefix === "eventName" ? t(eventNameKey(name)) : name;

  // Client-side filter that honours the free-text search input.
  const filtered = useMemo(() => {
    return alternatives.filter((s) =>
      (translatePrefix === "eventName" ? t(eventNameKey(s.toString())) : s.toString())
        .toLowerCase()
        .includes(deferredQuery.toLowerCase())
    );
  }, [alternatives, deferredQuery, translatePrefix, t]);

  const toggleStudent = (name: string) => {
    if (selected.includes(name)) {
      onChange(selected.filter((n) => n !== name));
    } else {
      onChange([...selected, name]);
    }
  };

  return (
    <Dialog open={isOpen} onClose={onClose} className="relative z-[1200]">
      <div data-modal-backdrop="" className="fixed inset-0 bg-black/40" aria-hidden="true" />
      <div
        data-modal-backdrop=""
        className="fixed inset-0 flex items-center justify-center p-4"
        style={{ paddingTop: "calc(var(--window-titlebar-height, 0px) + 1rem)" }}
      >
        <DialogPanel
          className="modal-surface w-full max-w-3xl overflow-y-auto overscroll-contain"
          style={{ maxHeight: "calc(100dvh - var(--window-titlebar-height, 0px) - 2rem)" }}
        >
          <div className="modal-header">
            <DialogTitle className="modal-title">{t("scheduler.selector")}</DialogTitle>
            <button onClick={onClose} aria-label={t("common.close")} className="modal-close">
              <X className="size-4" />
            </button>
          </div>

          <SearchInput
            placeholder={t("scheduler.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            containerClassName="mb-4"
          />

          {/* Candidate list */}
          <div className="ordered-selector-options flex flex-wrap gap-2 max-h-96 overflow-y-auto">
            {filtered.map((s) => {
              const name = s.toString();
              const active = selected.includes(name);
              return (
                <button
                  key={name}
                  onClick={() => toggleStudent(name)}
                  className={`px-3 py-1 rounded-full text-sm border transition ${
                    active
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-transparent text-foreground border-input hover:bg-secondary"
                  }`}
                >
                  {translateName(name)}
                </button>
              );
            })}
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
};

/** Renders the ordered multi selector component. */
export const OrderedMultiSelector: React.FC<MultiSelectorProps> = ({
  label,
  tooltip,
  values,
  onChange,
  className,
  alternatives = [],
  translatePrefix,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const { t } = useTranslation();
  const lowPerformanceMode = useUISetting((settings) => settings.lowPerformanceMode);
  const translateName = (name: string) =>
    translatePrefix === "eventName" ? t(eventNameKey(name)) : name;

  // Remove value from the ordered collection.
  const handleRemove = (name: string) => {
    onChange(values.filter((n) => n !== name));
  };

  // Apply the new order emitted by the drag-and-drop group.
  const handleReorder = (newOrder: string[]) => {
    onChange(newOrder);
  };

  // Open the modal so the user can append new entries.
  const handleAdd = () => {
    setIsOpen(true);
  };

  return (
    <>
      <div className="ordered-selector">
        {label &&
          (tooltip ? (
            <LabelWithTooltip
              className="block text-sm font-medium mb-2"
              label={label}
              tooltip={tooltip}
            />
          ) : (
            <label className="block text-sm font-medium mb-2">{label}</label>
          ))}

        <div className={cn("space-y-2", className)}>
          <div className="ordered-selector-scroll overflow-x-auto pb-1">
            <Reorder.Group
              axis="x"
              values={values}
              onReorder={handleReorder}
              className="ordered-selector-list flex gap-1 min-w-max"
            >
              {values.map((name, index) => (
                <Reorder.Item
                  key={name}
                  value={name}
                  layout={lowPerformanceMode ? undefined : true}
                  transition={{ duration: lowPerformanceMode ? 0 : 0.18 }}
                  className={cn(
                    "ordered-selector-item flex items-center gap-2 px-3 py-0.5 shrink-0",
                    "rounded-lg border border-input",
                    "bg-secondary/50 text-foreground",
                    "transition-colors hover:bg-secondary",
                    "cursor-grab"
                  )}
                >
                  {/* Index badge */}
                  <span className="flex items-center justify-center w-5 h-5 text-xs font-medium rounded-md bg-accent text-muted-foreground">
                    {index + 1}
                  </span>

                  <span className="text-sm">{translateName(name)}</span>

                  {/* Remove button */}
                  <button
                    type="button"
                    onClick={() => handleRemove(name)}
                    aria-label={`${t("common.delete")} ${translateName(name)}`}
                    className="ordered-selector-remove ml-1 inline-flex items-center justify-center w-5 h-5 rounded-md text-muted-foreground hover:bg-accent hover:text-destructive transition-colors"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </Reorder.Item>
              ))}

              {/* Add button */}
              <button
                type="button"
                onClick={handleAdd}
                className={cn(
                  "ordered-selector-add flex items-center gap-1 px-3 py-0.5 shrink-0",
                  "rounded-lg border border-dashed border-input",
                  "text-muted-foreground",
                  "hover:bg-secondary hover:text-foreground"
                )}
              >
                <Plus className="w-4 h-4" /> {t("common.add")}
              </button>
            </Reorder.Group>
          </div>
        </div>
      </div>

      {/* Selection modal */}
      <SelectorModal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        alternatives={alternatives}
        selected={values}
        onChange={(list: any[]) => {
          onChange(list); // Pass-through to parent handler.
        }}
        translatePrefix={translatePrefix}
      />
    </>
  );
};

/** Renders the time selector modal component. */
export const TimeSelectorModal: React.FC<TimeModeProps | RangeModeProps> = ({
  label,
  tooltip,
  values,
  onChange,
  className,
  mode = "time",
}) => {
  const { t } = useTranslation();

  /** Handles the handle time add interaction. */
  const handleTimeAdd = (): void => {
    if (mode === "time") {
      const list = values as number[][];
      onChange([...list, [0, 0, 0]] as any);
    }
  };

  /** Handles the handle range add interaction. */
  const handleRangeAdd = (): void => {
    if (mode === "range") {
      const list = values as number[][][];
      onChange([
        ...list,
        [
          [0, 0, 0],
          [23, 59, 59],
        ],
      ] as any);
    }
  };

  /** Handles the handle remove interaction. */
  const handleRemove = (index: number): void => {
    onChange(values.filter((_, i) => i !== index) as any);
  };

  const pad = (n: number) => String(n).padStart(2, "0");

  const forwardHandler = (value: number[]): string => {
    if (value.length === 2) {
      return `${pad(value[0])}:${pad(value[1])}`;
    } else {
      return `${pad(value[0])}:${pad(value[1])}:${pad(value[2])}`;
    }
  };

  const backwardHandler = (value: string): number[] => {
    return value.split(":").map((e) => parseInt(e));
  };

  return (
    <div className="time-selector" data-time-mode={mode}>
      {label &&
        (tooltip ? (
          <LabelWithTooltip
            className="block text-sm font-medium mb-2"
            label={label}
            tooltip={tooltip}
          />
        ) : (
          <label className="block text-sm font-medium mb-2">{label}</label>
        ))}

      <div className={cn("space-y-2", className)}>
        <div className="time-selector-list overflow-x-auto pb-2 flex flex-row gap-1 scroll-embedded">
          {values.map((item, index) => (
            <div
              key={index}
              className={cn(
                "time-selector-item flex items-center gap-1 px-2 shrink-0",
                "rounded-lg border border-input",
                "bg-secondary/50 text-foreground",
                "transition-colors hover:bg-secondary"
              )}
            >
              {mode === "time" && (
                <FormInput
                  type="time"
                  value={forwardHandler(item as number[])}
                  step="1"
                  onChange={(e) => {
                    const time = e.target.value;
                    const arr = backwardHandler(time);
                    const newValues = [...(values as number[][])];
                    newValues[index] = arr;
                    onChange(newValues as any);
                  }}
                  className="time-selector-field w-20.5 md:w-18.5"
                  childClassName="h-6 px-1 bg-background shadow-none translate-y-[-1px]"
                />
              )}

              {mode === "range" && (
                <div className="time-selector-range flex items-center gap-1">
                  {(item as number[][]).map((point, i) => (
                    <React.Fragment key={i}>
                      {i === 1 && (
                        <span className="time-selector-separator mx-1 text-muted-foreground">
                          ~
                        </span>
                      )}
                      <FormInput
                        type="time"
                        value={forwardHandler(point)}
                        step="1"
                        onChange={(e) => {
                          const arr = backwardHandler(e.target.value);
                          const newValues = [...(values as number[][][])];
                          newValues[index][i] = arr;
                          onChange(newValues as any);
                        }}
                        className="time-selector-field w-18.5"
                        childClassName="h-6 px-1 bg-background shadow-none translate-y-[-1px]"
                      />
                    </React.Fragment>
                  ))}
                </div>
              )}

              <button
                type="button"
                onClick={() => handleRemove(index)}
                aria-label={t("common.delete")}
                className="time-selector-remove inline-flex items-center justify-center w-5 h-5
                rounded-md text-muted-foreground hover:bg-accent hover:text-destructive transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}

          {/* Add button */}
          <button
            type="button"
            onClick={mode === "time" ? handleTimeAdd : handleRangeAdd}
            className={cn(
              "time-selector-add flex items-center gap-1 px-3 py-0.5 shrink-0",
              "rounded-lg border border-dashed border-input",
              "text-muted-foreground",
              "hover:bg-secondary hover:text-foreground"
            )}
          >
            <Plus className="w-4 h-4" /> {t("common.add")}
          </button>
        </div>
      </div>
    </div>
  );
};

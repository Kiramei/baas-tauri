import {Reorder} from "framer-motion";
import {Plus, X} from "lucide-react";
import React, {useMemo, useState} from "react";
import {cn} from "@/lib/utils"
import {Dialog, DialogPanel, DialogTitle} from "@headlessui/react";
import {useTranslation} from "react-i18next";
import {LabelWithTooltip} from "@/components/ui/LabelWithTooltip.tsx";
import {FormInput} from "@/components/ui/FormInput.tsx";

interface MultiSelectorProps {
  label?: string
  tooltip?: string
  values: any[]
  onChange: (newValues: any[]) => void
  className?: string
  alternatives: any[]
  translatePrefix?: string
}

interface SelectorModalProps {
  isOpen: boolean;
  onClose: () => void;
  alternatives: any[];
  selected: string[];
  onChange: (list: string[]) => void;
  lang?: "CN" | "JP" | "Global";
  mode?: "single" | "multiple";
  translatePrefix?: string
}

interface BaseTimeProps {
  label?: string
  tooltip?: string
  className?: string
}

interface TimeModeProps extends BaseTimeProps {
  mode?: "time"
  values: number[][]
  onChange: (list: number[][]) => void
}

interface RangeModeProps extends BaseTimeProps {
  mode: "range"
  values: number[][][]
  onChange: (list: number[][][]) => void
}


const SelectorModal: React.FC<SelectorModalProps> = (
  {
    isOpen,
    onClose,
    alternatives,
    selected,
    onChange,
    translatePrefix,
  }
) => {
  const {t} = useTranslation()
  const [query, setQuery] = useState("");

  // Client-side filter that honours the free-text search input.
  const filtered = useMemo(() => {
    return alternatives.filter((s) =>
      (translatePrefix ? t(translatePrefix + "." + s) : s).toString().toLowerCase().includes(query.toLowerCase())
    );
  }, [query, alternatives]);

  const toggleStudent = (name: string) => {
    if (selected.includes(name)) {
      onChange(selected.filter((n) => n !== name));
    } else {
      onChange([...selected, name]);
    }
  };

  return (
    <Dialog open={isOpen} onClose={onClose} className="relative z-50">
      <div className="fixed inset-0 bg-black/30" aria-hidden="true"/>
      <div className="fixed inset-0 flex items-center justify-center">
        <DialogPanel className="w-full max-w-3xl rounded-lg bg-white dark:bg-slate-800 p-6 shadow-lg">
          <div className="flex justify-between items-center mb-4">
            <DialogTitle className="text-lg font-semibold">
              {t("scheduler.selector")}
            </DialogTitle>
            <button onClick={onClose}>
              <X className="w-5 h-5 text-slate-500"/>
            </button>
          </div>

          <input
            type="text"
            placeholder={t("scheduler.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full mb-4 px-3 py-2 border rounded-md focus:ring-primary-500 focus:border-primary-500"
          />

          {/* Candidate list */}
          <div className="flex flex-wrap gap-2 max-h-96 overflow-y-auto">
            {filtered.map((s) => {
              const name = s.toString();
              const active = selected.includes(name);
              return (
                <button
                  key={name}
                  onClick={() => toggleStudent(name)}
                  className={`px-3 py-1 rounded-full text-sm border transition ${
                    active
                      ? "bg-primary-600 text-white border-primary-600"
                      : "bg-slate-100 dark:bg-slate-700 border-slate-300"
                  }`}
                >
                  {translatePrefix ? t(translatePrefix + "." + name) : name}
                </button>
              );
            })}
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
};


export const OrderedMultiSelector: React.FC<MultiSelectorProps> = (
  {
    label,
    tooltip,
    values,
    onChange,
    className,
    alternatives = [],
    translatePrefix,
  }
) => {
  const [isOpen, setIsOpen] = useState(false)
  const {t} = useTranslation()

  // Remove value from the ordered collection.
  const handleRemove = (name: string) => {
    onChange(values.filter((n) => n !== name))
  }

  // Apply the new order emitted by the drag-and-drop group.
  const handleReorder = (newOrder: string[]) => {
    onChange(newOrder)
  }

  // Open the modal so the user can append new entries.
  const handleAdd = () => {
    setIsOpen(true)
  }

  return (
    <>
      <div>
        {label && (
          tooltip ?
            <LabelWithTooltip
              className="block text-sm font-medium mb-2"
              label={label}
              tooltip={tooltip}
            />
            :
            <label className="block text-sm font-medium mb-2">
              {label}
            </label>)
        }

        <div className={cn("space-y-2", className)}>
          <div className="overflow-x-auto pb-1">
            <Reorder.Group
              axis="x"
              values={values}
              onReorder={handleReorder}
              className="flex gap-1 min-w-max"
            >
              {values.map((name, index) => (
                <Reorder.Item
                  key={name}
                  value={name}
                  className={cn(
                    "flex items-center gap-2 px-3 py-0.5 shrink-0",
                    "rounded-full border border-slate-300 dark:border-slate-600",
                    "bg-slate-100 dark:bg-slate-700",
                    "shadow-sm hover:shadow-md",
                    "cursor-grab"
                  )}
                >
                  {/* Index badge */}
                  <span
                    className="flex items-center justify-center w-5 h-5 text-xs font-medium rounded-full bg-primary text-primary-foreground">
                    {index + 1}
                  </span>

                  <span className="text-sm">{translatePrefix ? t(translatePrefix + "." + name) : name}</span>

                  {/* Remove button */}
                  <button
                    onClick={() => handleRemove(name)}
                    className="ml-1 inline-flex items-center justify-center w-5 h-5 rounded-full text-red-500 hover:bg-red-100 dark:hover:bg-red-900 transition"
                  >
                    <X className="w-3.5 h-3.5"/>
                  </button>
                </Reorder.Item>
              ))}

              {/* Add button */}
              <button
                onClick={handleAdd}
                className={cn(
                  "flex items-center gap-1 px-3 py-0.5 shrink-0",
                  "rounded-full border-2 border-dashed border-slate-300 dark:border-slate-600",
                  "text-slate-600 dark:text-slate-200",
                  "hover:bg-slate-100 dark:hover:bg-slate-600"
                )}
              >
                <Plus className="w-4 h-4"/> {t("add")}
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
  )
}


export const TimeSelectorModal: React.FC<TimeModeProps | RangeModeProps> = (
  {
    label,
    tooltip,
    values,
    onChange,
    className,
    mode = "time",
  }
) => {
  const {t} = useTranslation()

  const handleTimeAdd = (): void => {
    if (mode === "time") {
      const list = values as number[][]
      onChange([...list, [0, 0, 0]] as any)
    }
  }

  const handleRangeAdd = (): void => {
    if (mode === "range") {
      const list = values as number[][][]
      onChange([...list, [[0, 0, 0], [23, 59, 59]]] as any)
    }
  }

  const handleRemove = (index: number): void => {
    onChange(values.filter((_, i) => i !== index) as any)
  }

  const pad = (n: number) => String(n).padStart(2, "0")

  const forwardHandler = (value: number[]): string => {
    if (value.length === 2) {
      return `${pad(value[0])}:${pad(value[1])}`
    } else {
      return `${pad(value[0])}:${pad(value[1])}:${pad(value[2])}`
    }
  }

  const backwardHandler = (value: string): number[] => {
    return value.split(":").map((e) => parseInt(e))
  }

  return (
    <div>
      {label && (
        tooltip ? (
          <LabelWithTooltip
            className="block text-sm font-medium mb-2"
            label={label}
            tooltip={tooltip}
          />
        ) : (
          <label className="block text-sm font-medium mb-2">{label}</label>
        )
      )}

      <div className={cn("space-y-2", className)}>
        <div className="overflow-x-auto pb-2 flex flex-row gap-1 scroll-embedded">
          {values.map((item, index) => (
            <div
              key={index}
              className={cn(
                "flex items-center gap-1 px-2 shrink-0",
                "rounded-full border border-slate-300 dark:border-slate-600",
                "bg-slate-100 dark:bg-slate-700",
                "shadow-sm hover:shadow-md"
              )}
            >
              {mode === "time" && (
                <FormInput
                  type="time"
                  value={forwardHandler(item as number[])}
                  step="1"
                  onChange={(e) => {
                    const time = e.target.value
                    const arr = backwardHandler(time)
                    const newValues = [...(values as number[][])]
                    newValues[index] = arr
                    onChange(newValues as any)
                  }}
                  className="w-20.5 md:w-18.5"
                  childClassName="h-6 px-1 bg-slate-200 dark:bg-slate-600 shadow-none translate-y-[-1px]"
                />
              )}

              {mode === "range" && (
                <div className="flex items-center gap-1">
                  {(item as number[][]).map((point, i) => (
                    <React.Fragment key={i}>
                      {i === 1 && (
                        <span className="mx-1 text-slate-500 dark:text-slate-300">~</span>
                      )}
                      <FormInput
                        type="time"
                        value={forwardHandler(point)}
                        step="1"
                        onChange={(e) => {
                          const arr = backwardHandler(e.target.value)
                          const newValues = [...(values as number[][][])]
                          newValues[index][i] = arr
                          onChange(newValues as any)
                        }}
                        className="w-18.5"
                        childClassName="h-6 px-1 bg-slate-200 dark:bg-slate-600 shadow-none translate-y-[-1px]"
                      />
                    </React.Fragment>
                  ))}
                </div>
              )}

              <button
                onClick={() => handleRemove(index)}
                className="inline-flex items-center justify-center w-5 h-5
                rounded-full text-red-500 hover:bg-red-100 dark:hover:bg-red-900 transition"
              >
                <X className="w-3.5 h-3.5"/>
              </button>
            </div>
          ))}

          {/* 添加按钮 */}
          <button
            onClick={mode === "time" ? handleTimeAdd : handleRangeAdd}
            className={cn(
              "flex items-center gap-1 px-3 py-0.5 shrink-0",
              "rounded-full border-2 border-dashed border-slate-300 dark:border-slate-600",
              "text-slate-600 dark:text-slate-200",
              "hover:bg-slate-100 dark:hover:bg-slate-600"
            )}
          >
            <Plus className="w-4 h-4"/> {t("add")}
          </button>
        </div>
      </div>
    </div>
  )
}

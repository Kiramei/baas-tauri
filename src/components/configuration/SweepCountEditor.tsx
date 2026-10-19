import type { ReactNode } from "react";
import { useAppTranslation } from "@/shared/useAppTranslation";
import { ConfigurationRow } from "./ConfigurationControls";
import { FormInput } from "@/components/ui/FormInput";
import { FormSelect } from "@/components/ui/FormSelect";
import {
  activitySweepCountToken,
  readActivitySweepCounts,
  readSweepCountTokens,
  replaceActivitySweepCount,
  replaceSweepCountToken,
  type ActivitySweepCountMode,
} from "@/shared/SweepCounts";
import "./configuration-forms.css";

function PreservedCount({ value, onReset }: { value: string; onReset: () => void }) {
  const { t } = useAppTranslation();
  return (
    <ConfigurationRow
      label={t("configurationCounts.legacyTitle")}
      description={t("configurationCounts.legacyHint")}
      className="configuration-row-stacked"
    >
      <div className="flex min-w-0 items-center justify-between gap-3">
        <code className="min-w-0 overflow-x-auto whitespace-pre text-xs text-muted-foreground">
          {String(value)}
        </code>
        <button type="button" className="configuration-action shrink-0" onClick={onReset}>
          {t("configurationCounts.replace")}
        </button>
      </div>
    </ConfigurationRow>
  );
}

export function SweepCountEditor({
  value,
  labels,
  onChange,
}: {
  value: string;
  labels: readonly string[];
  onChange: (value: string) => void;
}) {
  const { t } = useAppTranslation();
  const counts = readSweepCountTokens(value, labels.length);
  if (!counts)
    return (
      <PreservedCount value={value} onReset={() => onChange(labels.map(() => "0").join(","))} />
    );
  const update = (index: number, next: string) => {
    const result = replaceSweepCountToken(value, labels.length, index, next);
    if (result !== null) onChange(result);
  };
  return (
    <>
      {counts.map((count, index) => {
        const mode =
          count === "max" ? "all" : count.trim() !== "" && Number(count) <= 0 ? "skip" : "count";
        return (
          <ConfigurationRow key={index} label={labels[index]} className="sweep-count-row">
            <div className={`sweep-count-controls ${mode === "count" ? "has-amount" : ""}`}>
              <FormSelect
                value={mode}
                onChange={(next) =>
                  update(index, next === "all" ? "max" : next === "skip" ? "0" : "1")
                }
                options={[
                  { value: "skip", label: t("configurationCounts.skip") },
                  { value: "count", label: t("configurationCounts.fixed") },
                  { value: "all", label: t("configurationCounts.all") },
                ]}
                ariaLabel={`${labels[index]}: ${t("configurationCounts.mode")}`}
                className="sweep-count-mode"
              />
              {mode === "count" && (
                <FormInput
                  type="number"
                  value={count.trim()}
                  onChange={(event) => update(index, event.target.value)}
                  min={1}
                  step={1}
                  aria-label={`${labels[index]}: ${t("configurationCounts.amount")}`}
                  aria-invalid={count.trim() === ""}
                  className="sweep-count-amount"
                />
              )}
            </div>
          </ConfigurationRow>
        );
      })}
      {counts.some((count) => count === "max") && (
        <p className="sweep-count-hint">{t("configurationCounts.countHint")}</p>
      )}
    </>
  );
}

export function ActivitySweepCountEditor({
  value,
  onChange,
  stages,
  stagePicker,
}: {
  value: string;
  onChange: (value: string) => void;
  stages?: unknown;
  stagePicker?: ReactNode;
}) {
  const { t } = useAppTranslation();
  const counts = readActivitySweepCounts(value);
  if (!counts) return <PreservedCount value={value} onReset={() => onChange("0")} />;
  const stageNumbers = Array.isArray(stages) ? stages.map(String) : String(stages ?? "").split(",");
  const update = (index: number, mode: ActivitySweepCountMode, amount?: string) => {
    const next = activitySweepCountToken(mode, amount);
    if (next === null) return;
    const result = replaceActivitySweepCount(value, index, next);
    if (result !== null) onChange(result);
  };
  return (
    <>
      {counts.map((count, index) => {
        const label =
          stagePicker && counts.length === 1
            ? t("sweep.activityNumber")
            : t("configurationCounts.activityEntry", {
                number: stageNumbers[index]?.trim() || index + 1,
              });
        const hasAmount = count.mode === "count" || count.mode === "share";
        return (
          <ConfigurationRow
            key={index}
            label={label}
            className={`sweep-count-row ${stagePicker ? "activity-sweep-row" : ""}`}
          >
            <div
              className={`sweep-count-controls ${hasAmount ? "has-amount" : ""} ${stagePicker ? "has-stage" : ""}`}
            >
              {stagePicker && <div className="sweep-count-stage">{stagePicker}</div>}
              <FormSelect
                value={count.mode}
                onChange={(mode) =>
                  update(index, mode as ActivitySweepCountMode, mode === "share" ? "50" : "1")
                }
                options={[
                  { value: "skip", label: t("configurationCounts.skip") },
                  { value: "count", label: t("configurationCounts.fixed") },
                  { value: "share", label: t("configurationCounts.share") },
                  ...(counts.length === 1
                    ? [{ value: "all", label: t("configurationCounts.allActivity") }]
                    : []),
                ]}
                ariaLabel={`${label}: ${t("configurationCounts.mode")}`}
                className="sweep-count-mode"
              />
              {hasAmount && (
                <div className="sweep-count-amount-with-unit">
                  <FormInput
                    type="number"
                    value={count.amount}
                    onChange={(event) => update(index, count.mode, event.target.value)}
                    min={count.mode === "share" ? 0 : 1}
                    max={count.mode === "share" ? 100 : undefined}
                    step={count.mode === "share" ? "any" : 1}
                    aria-label={`${label}: ${count.mode === "share" ? t("configurationCounts.percent") : t("configurationCounts.amount")}`}
                    aria-invalid={!count.valid}
                    className="sweep-count-amount"
                  />
                  {count.mode === "share" && (
                    <span aria-hidden="true" className="sweep-count-unit">
                      %
                    </span>
                  )}
                </div>
              )}
            </div>
          </ConfigurationRow>
        );
      })}
      {counts.some((count) => count.mode === "share" || count.mode === "all") && (
        <p className="sweep-count-hint">{t("configurationCounts.activityHint")}</p>
      )}
    </>
  );
}

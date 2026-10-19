import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { FormInput } from "@/components/ui/FormInput";
import { FormSelect } from "@/components/ui/FormSelect";
import { IconTooltip } from "@/components/ui/Tooltip";
import { useAppTranslation } from "@/shared/useAppTranslation";
import {
  isSweepPlanValid,
  normalizeSweepPlanValue,
  parseSweepPlan,
  sweepPlanAllowsMax,
  type SweepPlanError,
  type SweepPlanMode,
  type SweepPlanOptions,
} from "@/shared/SweepPlan";
import "./sweep-plan-editor.css";

export interface SweepPlanEditorProps {
  value: string;
  onChange: (value: string) => void;
  mode: SweepPlanMode;
  server: string;
  maxChapter?: number;
  ariaLabel: string;
}
type EditorRow =
  | { id: string; kind: "stage"; chapter: string; mission: string; count: string; maximum: boolean }
  | { id: string; kind: "invalid"; raw: string; error: SweepPlanError };

function rowValue(row: EditorRow): string {
  return row.kind === "invalid"
    ? row.raw
    : [row.chapter, row.mission, row.maximum ? "max" : row.count].join("-");
}

function readRows(input: string, options: SweepPlanOptions, prefix: string): EditorRow[] {
  return parseSweepPlan(input, options).map((item, index) => {
    const id = prefix + "-" + index;
    return item.kind === "invalid"
      ? { ...item, id }
      : {
          id,
          kind: "stage",
          chapter: String(item.chapter),
          mission: String(item.mission),
          count: item.count === "max" ? "3" : String(item.count),
          maximum: item.count === "max",
        };
  });
}

/** Ordered stages expose the existing script syntax as ordinary controls. */
export default function SweepPlanEditor({
  value,
  onChange,
  mode,
  server,
  maxChapter,
  ariaLabel,
}: SweepPlanEditorProps) {
  const { t } = useAppTranslation();
  const instanceId = useId();
  const nextId = useRef(0);
  const source = normalizeSweepPlanValue(value);
  const observedSource = useRef(source);
  const emittedSource = useRef<string | null>(null);
  const options = { mode, server, maxChapter };
  const [rows, setRows] = useState<EditorRow[]>(() =>
    readRows(source, options, instanceId + "-initial")
  );
  useEffect(() => {
    if (observedSource.current === source) return;
    observedSource.current = source;
    if (emittedSource.current === source) {
      emittedSource.current = null;
      return;
    }
    setRows(
      readRows(source, { mode, server, maxChapter }, instanceId + "-sync-" + nextId.current++)
    );
  }, [source, mode, server, maxChapter, instanceId]);

  const allowMax = sweepPlanAllowsMax(mode, server);
  const missionLimit = mode === "hard" ? 3 : 5;
  const chapterLimit =
    typeof maxChapter === "number" && Number.isSafeInteger(maxChapter) && maxChapter > 0
      ? maxChapter
      : null;
  const chapterOptions =
    chapterLimit && chapterLimit <= 2000
      ? Array.from({ length: chapterLimit }, (_, index) => ({
          value: String(index + 1),
          label: String(index + 1),
        }))
      : null;
  const missionOptions = Array.from({ length: missionLimit }, (_, index) => ({
    value: String(index + 1),
    label: String(index + 1),
  }));
  const serialized = rows.map(rowValue).join(", ");
  const valid = isSweepPlanValid(serialized, options);
  const commit = (next: EditorRow[]) => {
    setRows(next);
    const output = next.map(rowValue).join(", ");
    // Keep temporary edits local until every entry can be executed safely.
    if (isSweepPlanValid(output, options) && output !== source) {
      emittedSource.current = output;
      onChange(output);
    }
  };
  const update = (id: string, patch: Partial<Extract<EditorRow, { kind: "stage" }>>) =>
    commit(rows.map((row) => (row.id === id && row.kind === "stage" ? { ...row, ...patch } : row)));
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= rows.length) return;
    const next = [...rows];
    [next[index], next[target]] = [next[target], next[index]];
    commit(next);
  };
  const errorMessage = (error: SweepPlanError) => {
    switch (error) {
      case "chapter":
        return t("sweepPlan.invalidChapter");
      case "mission":
        return t("sweepPlan.invalidMission");
      case "count":
        return t("sweepPlan.invalidCount");
      case "maxUnsupported":
        return t("sweepPlan.maxUnsupported");
      default:
        return t("sweepPlan.invalidFormat");
    }
  };

  return (
    <div className="sweep-plan-editor" role="group" aria-label={ariaLabel}>
      {rows.length === 0 && <p className="sweep-plan-empty">{t("sweepPlan.empty")}</p>}
      <div className="sweep-plan-rows">
        {rows.map((row, index) => {
          const parsed = parseSweepPlan(rowValue(row), options)[0];
          const error = parsed?.kind === "invalid" ? parsed.error : null;
          const rowLabel = t("sweepPlan.row", { number: index + 1 });
          return (
            <div key={row.id} className="sweep-plan-entry">
              <div className="sweep-plan-entry-heading">
                <span className="sweep-plan-entry-number">{rowLabel}</span>
                <div className="sweep-plan-actions">
                  <IconTooltip content={t("sweepPlan.up")}>
                    <button
                      type="button"
                      className="sweep-plan-icon"
                      aria-label={rowLabel + " " + t("sweepPlan.up")}
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                    >
                      <ChevronUp />
                    </button>
                  </IconTooltip>
                  <IconTooltip content={t("sweepPlan.down")}>
                    <button
                      type="button"
                      className="sweep-plan-icon"
                      aria-label={rowLabel + " " + t("sweepPlan.down")}
                      disabled={index === rows.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      <ChevronDown />
                    </button>
                  </IconTooltip>
                  <IconTooltip content={t("sweepPlan.remove")}>
                    <button
                      type="button"
                      className="sweep-plan-icon"
                      aria-label={rowLabel + " " + t("sweepPlan.remove")}
                      onClick={() => commit(rows.filter((entry) => entry.id !== row.id))}
                    >
                      <Trash2 />
                    </button>
                  </IconTooltip>
                </div>
              </div>
              {row.kind === "invalid" ? (
                <div className="sweep-plan-invalid">
                  <code className="sweep-plan-original">
                    {row.raw || t("sweepPlan.emptyEntry")}
                  </code>
                  <p role="alert">
                    {errorMessage(error ?? row.error)} {t("sweepPlan.repair")}
                  </p>
                </div>
              ) : (
                <div className="sweep-plan-fields">
                  {chapterOptions ? (
                    <FormSelect
                      label={t("sweepPlan.chapter")}
                      ariaLabel={ariaLabel + " " + rowLabel + " " + t("sweepPlan.chapter")}
                      value={row.chapter}
                      onChange={(chapter) => update(row.id, { chapter })}
                      options={chapterOptions}
                    />
                  ) : (
                    <FormInput
                      label={t("sweepPlan.chapter")}
                      aria-label={ariaLabel + " " + rowLabel + " " + t("sweepPlan.chapter")}
                      type="number"
                      min={1}
                      step={1}
                      value={row.chapter}
                      onChange={(event) => update(row.id, { chapter: event.target.value })}
                    />
                  )}
                  <FormSelect
                    label={t("sweepPlan.mission")}
                    ariaLabel={ariaLabel + " " + rowLabel + " " + t("sweepPlan.mission")}
                    value={row.mission}
                    onChange={(mission) => update(row.id, { mission })}
                    options={missionOptions}
                  />
                  <div className="sweep-plan-count">
                    <label className="sweep-plan-field-label">{t("sweepPlan.count")}</label>
                    <div className="sweep-plan-count-controls">
                      {(!row.maximum || !allowMax) && (
                        <FormInput
                          type="number"
                          min={0}
                          step={1}
                          value={row.count}
                          aria-label={ariaLabel + " " + rowLabel + " " + t("sweepPlan.count")}
                          aria-invalid={error === "count"}
                          onChange={(event) =>
                            update(row.id, { count: event.target.value, maximum: false })
                          }
                          className="sweep-plan-count-input"
                        />
                      )}
                      {allowMax && (
                        <FormSelect
                          value={row.maximum ? "max" : "count"}
                          onChange={(next) => update(row.id, { maximum: next === "max" })}
                          options={[
                            { value: "count", label: t("sweepPlan.fixedCount") },
                            { value: "max", label: t("sweepPlan.maximum") },
                          ]}
                          ariaLabel={ariaLabel + " " + rowLabel + " " + t("sweepPlan.countMode")}
                          className="sweep-plan-count-mode"
                        />
                      )}
                    </div>
                  </div>
                  {error && (
                    <p className="sweep-plan-error" role="alert">
                      {errorMessage(error)}
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="sweep-plan-add"
        onClick={() =>
          commit([
            ...rows,
            {
              id: instanceId + "-" + nextId.current++,
              kind: "stage",
              chapter: "1",
              mission: "1",
              count: "3",
              maximum: false,
            },
          ])
        }
      >
        <Plus aria-hidden="true" />
        {t("sweepPlan.add")}
      </button>
      {!valid && (
        <p role="status" className="sweep-plan-pending">
          {t("sweepPlan.unsaved")}
        </p>
      )}
      {!allowMax && <p className="sweep-plan-hint">{t("sweepPlan.maxUnsupported")}</p>}
    </div>
  );
}

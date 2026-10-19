import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { FormSelect } from "@/components/ui/FormSelect";
import { useAppTranslation } from "@/shared/useAppTranslation";
import {
  createExplorePlanEntry,
  exploreMissionChoices,
  parseExplorePlan,
  serializeExplorePlan,
  type ExplorePlanEntry,
  type ExplorePlanMode,
} from "@/shared/ExplorePlan";
import "./configuration-forms.css";

interface ExplorePlanEditorProps {
  value: unknown;
  onChange: (value: string) => void;
  mode: ExplorePlanMode;
  chapterRange?: readonly number[];
  maxChapter?: number;
  ariaLabel: string;
}

/** Choose chapters and missions without exposing the comma/hyphen storage syntax. */
export function ExplorePlanEditor({
  value,
  onChange,
  mode,
  chapterRange,
  maxChapter,
  ariaLabel,
}: ExplorePlanEditorProps) {
  const { t } = useAppTranslation();
  const minimum = Math.max(1, Number(chapterRange?.[0]) || (mode === "normal" ? 4 : 1));
  const maximum = Math.max(
    minimum,
    Math.min(250, Number(chapterRange?.[1]) || 30, Number(maxChapter) || 30)
  );
  const chapters = Array.from({ length: maximum - minimum + 1 }, (_, index) => minimum + index);
  const rows = parseExplorePlan(
    Array.isArray(value) ? (value.length ? JSON.stringify(value) : "") : String(value ?? "")
  );
  const commit = (next: readonly ExplorePlanEntry[]) => onChange(serializeExplorePlan(next));
  const replace = (index: number, chapter: number, mission: string) => {
    const next = createExplorePlanEntry(chapter, mission, mode);
    if (next) commit(rows.map((item, row) => (row === index ? next : item)));
  };
  const move = (index: number, direction: number) => {
    const next = [...rows];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    commit(next);
  };
  const chapterLabel = (chapter: number) => t("friendlyPriority.chapterLabel", { chapter });
  const missionLabel = (mission: string) =>
    mission === "all"
      ? t("friendlyPriority.wholeChapter")
      : mission === "A"
        ? t("friendlyPriority.missionA")
        : t("friendlyPriority.missionLabel", { mission });
  return (
    <div className="explore-plan-editor" role="group" aria-label={ariaLabel}>
      {rows.length > 0 ? (
        <ol className="divide-y divide-border/60">
          {rows.map((entry, index) => (
            <li key={index} className="explore-plan-row">
              <span className="w-5 shrink-0 text-center text-xs tabular-nums text-muted-foreground">
                {index + 1}
              </span>
              {entry.chapter !== null && entry.mission !== null ? (
                <div className="explore-plan-fields">
                  <FormSelect
                    value={String(entry.chapter)}
                    options={[...new Set([entry.chapter, ...chapters])]
                      .sort((left, right) => left - right)
                      .map((chapter) => ({ value: String(chapter), label: chapterLabel(chapter) }))}
                    ariaLabel={`${ariaLabel}: ${index + 1} ${t("friendlyPriority.chapter")}`}
                    className="min-w-0"
                    onChange={(chapter) => {
                      const choices = exploreMissionChoices(Number(chapter), mode);
                      replace(
                        index,
                        Number(chapter),
                        choices.includes(entry.mission!) ? entry.mission! : "all"
                      );
                    }}
                  />
                  <FormSelect
                    value={entry.mission}
                    options={[
                      ...new Set([entry.mission, ...exploreMissionChoices(entry.chapter, mode)]),
                    ].map((mission) => ({ value: mission, label: missionLabel(mission) }))}
                    ariaLabel={`${ariaLabel}: ${index + 1} ${t("friendlyPriority.mission")}`}
                    className="min-w-0"
                    onChange={(mission) => replace(index, entry.chapter!, mission)}
                  />
                </div>
              ) : (
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-muted-foreground">
                    {t("friendlyPriority.legacyValue")}
                  </p>
                  <code className="break-all text-sm">
                    {entry.raw || t("friendlyPriority.emptyLegacy")}
                  </code>
                </div>
              )}
              <div className="explore-plan-actions">
                <button
                  type="button"
                  onClick={() => move(index, -1)}
                  disabled={index === 0}
                  aria-label={t("friendlyPriority.moveUp")}
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary disabled:opacity-25"
                >
                  <ChevronUp size={15} />
                </button>
                <button
                  type="button"
                  onClick={() => move(index, 1)}
                  disabled={index === rows.length - 1}
                  aria-label={t("friendlyPriority.moveDown")}
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary disabled:opacity-25"
                >
                  <ChevronDown size={15} />
                </button>
                <button
                  type="button"
                  onClick={() => commit(rows.filter((_, row) => row !== index))}
                  aria-label={`${t("common.delete")}: ${entry.raw}`}
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </li>
          ))}
        </ol>
      ) : null}
      <div className="explore-plan-footer">
        {rows.length === 0 && (
          <p className="text-xs text-muted-foreground">{t("friendlyPriority.emptyExplore")}</p>
        )}
        <button
          type="button"
          className="configuration-action"
          onClick={() => {
            const next = createExplorePlanEntry(minimum, "all", mode);
            if (next) commit([...rows, next]);
          }}
        >
          <Plus size={14} aria-hidden="true" />
          {t("friendlyPriority.addChapter")}
        </button>
      </div>
    </div>
  );
}

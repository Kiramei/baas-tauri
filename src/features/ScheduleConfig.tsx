import React, { useMemo, useState } from "react";
import { useAppTranslation } from "@/shared/useAppTranslation";
import { Check, Plus, X } from "lucide-react";
import { Reorder } from "framer-motion";
import {
  ConfigurationGroup,
  ConfigurationInput,
  ConfigurationRow,
  ConfigurationToggle,
} from "@/components/configuration/ConfigurationControls";
import StudentSelectorModal from "@/components/StudentSelectorModal";
import { useWebSocketStore } from "@/store/WebsocketStore";
import { DynamicConfig, LessonEachRegionObjectPriority } from "@/types/dynamic";
import { serverMap, serverMapSpec } from "@/shared/GlobalUtilities";
import { scheduleLevelKey } from "@/shared/I18nKeys";
import { useUISetting } from "@/context/UISettingsProvider";
import { useConfigurationDraft } from "@/shared/useConfigurationDraft";

type LessonConfigProps = {
  onClose: () => void;
  profileId?: string;
  settings?: Partial<DynamicConfig>;
  onChange?: (patch: Partial<DynamicConfig>) => Promise<void>;
};
type Draft = {
  lesson_enableInviteFavorStudent: boolean;
  lesson_favorStudent: string[];
  lesson_relationship_first: boolean;
  lesson_each_region_object_priority: string[][];
  lesson_times: number[];
};
const levels: LessonEachRegionObjectPriority[] = ["primary", "normal", "advanced", "superior"];

/** Student preferences and per-campus lesson rules share the same automatic draft. */
const LessonConfig: React.FC<LessonConfigProps> = ({ profileId }) => {
  const { t } = useAppTranslation();
  const lowPerformanceMode = useUISetting((settings) => settings.lowPerformanceMode);
  const settings = useWebSocketStore((state) => state.configStore[profileId!]);
  const staticConfig = useWebSocketStore((state) => state.staticStore);
  const lessonNames: string[] =
    staticConfig.lesson_region_name?.[serverMapSpec[settings.server]] ?? [];
  const [showSelector, setShowSelector] = useState(false);
  const ext = useMemo<Draft>(
    () => ({
      lesson_enableInviteFavorStudent: settings.lesson_enableInviteFavorStudent ?? false,
      lesson_favorStudent: settings.lesson_favorStudent ?? [],
      lesson_relationship_first: settings.lesson_relationship_first ?? false,
      lesson_each_region_object_priority: lessonNames.map((_, index) =>
        Array.isArray(settings.lesson_each_region_object_priority?.[index])
          ? [...settings.lesson_each_region_object_priority[index]]
          : [...levels]
      ),
      lesson_times: lessonNames.map((_, index) => settings.lesson_times?.[index] ?? 1),
    }),
    [lessonNames, settings]
  );
  const [draft, setDraft] = useConfigurationDraft(profileId!, "schedule", ext);
  const toggleLevel = (index: number, level: string) =>
    setDraft((current) => ({
      ...current,
      lesson_each_region_object_priority: current.lesson_each_region_object_priority.map(
        (values, row) =>
          row !== index
            ? values
            : values.includes(level)
              ? values.filter((item) => item !== level)
              : [...values, level]
      ),
    }));
  return (
    <div className="space-y-6">
      <ConfigurationGroup title={t("schedule")}>
        <ConfigurationToggle
          label={t("lesson.enableFavorStudent")}
          description={t("configurationHelp.lessonFavorEnabled")}
          checked={draft.lesson_enableInviteFavorStudent}
          onChange={(value) =>
            setDraft((current) => ({ ...current, lesson_enableInviteFavorStudent: value }))
          }
        />
        <ConfigurationToggle
          label={t("lesson.relationshipFirst")}
          description={t("configurationHelp.lessonRelationshipFirst")}
          checked={draft.lesson_relationship_first}
          onChange={(value) =>
            setDraft((current) => ({ ...current, lesson_relationship_first: value }))
          }
        />
        {draft.lesson_enableInviteFavorStudent && (
          <ConfigurationRow
            label={t("lesson.favorStudent")}
            description={t("configurationHelp.lessonFavorOrder")}
            className="configuration-row-stacked"
          >
            <div className="max-w-full overflow-x-auto pb-1">
              <Reorder.Group
                axis="x"
                values={draft.lesson_favorStudent}
                onReorder={(values) =>
                  setDraft((current) => ({ ...current, lesson_favorStudent: values }))
                }
                className="flex min-w-max items-center gap-2"
              >
                {draft.lesson_favorStudent.map((name, index) => (
                  <Reorder.Item
                    key={name}
                    value={name}
                    layout={lowPerformanceMode ? undefined : true}
                    transition={{ duration: lowPerformanceMode ? 0 : 0.18 }}
                    className="flex cursor-grab items-center gap-2 rounded-full bg-secondary px-2.5 py-1 text-sm"
                  >
                    <span className="text-xs tabular-nums text-muted-foreground">{index + 1}</span>
                    <span>{name}</span>
                    <button
                      type="button"
                      aria-label={`${t("common.delete")}: ${name}`}
                      className="rounded-full p-0.5 text-muted-foreground hover:text-foreground"
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          lesson_favorStudent: current.lesson_favorStudent.filter(
                            (item) => item !== name
                          ),
                        }))
                      }
                    >
                      <X size={13} />
                    </button>
                  </Reorder.Item>
                ))}
                <button
                  type="button"
                  onClick={() => setShowSelector(true)}
                  className="inline-flex items-center gap-1 rounded-lg bg-secondary px-3 py-1.5 text-sm hover:bg-secondary/70"
                >
                  <Plus size={14} />
                  {t("common.add")}
                </button>
              </Reorder.Group>
            </div>
          </ConfigurationRow>
        )}
      </ConfigurationGroup>
      <ConfigurationGroup title={t("lesson.region")}>
        <ConfigurationRow
          label={t("configurationHelp.lessonRegionTable")}
          description={t("configurationHelp.lessonRegionTableHint")}
          className="configuration-row-stacked"
        >
          <div className="max-w-full overflow-x-auto">
            <table className="w-full min-w-[360px] text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="py-2 pr-3 text-left font-medium">{t("lesson.region")}</th>
                  {levels.map((level) => (
                    <th key={level} className="px-1 py-2 font-medium">
                      {t(scheduleLevelKey(level))}
                    </th>
                  ))}
                  <th className="py-2 pl-3 font-medium">{t("lesson.times")}</th>
                </tr>
              </thead>
              <tbody>
                {lessonNames.map((name, index) => (
                  <tr key={name} className="border-b border-border/60 last:border-0">
                    <td className="py-3 pr-3">{name}</td>
                    {levels.map((level) => (
                      <td key={level} className="px-1 py-3 text-center">
                        <label className="relative inline-flex items-center">
                          <input
                            type="checkbox"
                            aria-label={`${name}: ${t(scheduleLevelKey(level))}`}
                            checked={draft.lesson_each_region_object_priority[index].includes(
                              level
                            )}
                            onChange={() => toggleLevel(index, level)}
                            className="peer size-5 cursor-pointer appearance-none rounded-full border border-input bg-transparent checked:border-[var(--control-checked)] checked:bg-[var(--control-checked)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          />
                          <Check
                            aria-hidden="true"
                            className="pointer-events-none absolute inset-0.5 size-4 text-white opacity-0 peer-checked:opacity-100"
                          />
                        </label>
                      </td>
                    ))}
                    <td className="py-3 pl-3">
                      <ConfigurationInput
                        type="number"
                        aria-label={`${name}: ${t("lesson.times")}`}
                        min={0}
                        max={99}
                        value={draft.lesson_times[index]}
                        className="ml-auto w-16"
                        onChange={(event) => {
                          const value = Number(event.target.value);
                          if (Number.isFinite(value))
                            setDraft((current) => ({
                              ...current,
                              lesson_times: current.lesson_times.map((count, row) =>
                                row === index ? Math.max(0, Math.min(99, Math.trunc(value))) : count
                              ),
                            }));
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ConfigurationRow>
      </ConfigurationGroup>
      <StudentSelectorModal
        isOpen={showSelector}
        onClose={() => setShowSelector(false)}
        allStudents={staticConfig.student_names ?? []}
        selected={draft.lesson_favorStudent}
        onChange={(values) => setDraft((current) => ({ ...current, lesson_favorStudent: values }))}
        lang={serverMap[settings.server]}
      />
    </div>
  );
};
export default LessonConfig;

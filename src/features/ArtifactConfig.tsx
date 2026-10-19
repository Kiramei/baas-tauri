import React, { useMemo, useState } from "react";
import { useAppTranslation } from "@/shared/useAppTranslation";
import {
  ConfigurationGroup,
  ConfigurationInput,
  ConfigurationRow,
  ConfigurationSelect,
  ConfigurationToggle,
} from "@/components/configuration/ConfigurationControls";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/Tabs";
import { PriorityListEditor } from "@/components/configuration/PriorityListEditor";
import StudentSelectorModal from "@/components/StudentSelectorModal";
import { useWebSocketStore } from "@/store/WebsocketStore";
import { serverMap } from "@/shared/GlobalUtilities";
import { artifactPhaseKey } from "@/shared/I18nKeys";
import { useConfigurationDraft } from "@/shared/useConfigurationDraft";

type ArtifactConfigProps = { onClose: () => void; profileId: string };
type Draft = {
  use_acceleration_ticket: boolean;
  createTime: string | number;
  create_phase: number;
  create_phase_1_select_item_rule: string;
  create_phase_2_select_item_rule: string;
  create_phase_3_select_item_rule: string;
  createPriority_phase1: string[];
  createPriority_phase2: string[];
  createPriority_phase3: string[];
};
const priorityList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.map(String)
    : typeof value === "string"
      ? value
          .split(">")
          .map((item) => item.trim())
          .filter(Boolean)
      : [];
const serialize = (draft: Draft) =>
  draft.createTime === "" ||
  !Number.isInteger(Number(draft.createTime)) ||
  Number(draft.createTime) < 1 ||
  Number(draft.createTime) > 10
    ? null
    : { ...draft, createTime: String(Number(draft.createTime)) };

/** Crafting behavior and material priorities are edited inline and saved automatically. */
const ArtifactConfig: React.FC<ArtifactConfigProps> = ({ profileId }) => {
  const { t } = useAppTranslation();
  const settings = useWebSocketStore((state) => state.configStore[profileId]);
  const staticConfig = useWebSocketStore((state) => state.staticStore);
  const ext = useMemo<Draft>(
    () => ({
      use_acceleration_ticket: settings.use_acceleration_ticket ?? false,
      createTime: settings.createTime ?? "1",
      create_phase: settings.create_phase ?? 1,
      create_phase_1_select_item_rule: settings.create_phase_1_select_item_rule ?? "default",
      create_phase_2_select_item_rule: settings.create_phase_2_select_item_rule ?? "primary_normal",
      create_phase_3_select_item_rule:
        settings.create_phase_3_select_item_rule ?? "advanced_superior",
      createPriority_phase1: priorityList(settings.createPriority_phase1),
      createPriority_phase2: priorityList(settings.createPriority_phase2),
      createPriority_phase3: priorityList(settings.createPriority_phase3),
    }),
    [settings]
  );
  const [draft, setDraft] = useConfigurationDraft(profileId, "artifact", ext, { serialize });
  const [tab, setTab] = useState("global");
  const [studentSelector, setStudentSelector] = useState(false);
  const methods: Record<number, { value: string; label: string }[]> = {
    1: [{ value: "default", label: t("artifact.default") }],
    2: [
      { value: "primary", label: t("artifact.white") },
      { value: "normal", label: t("artifact.blue") },
      { value: "primary_normal", label: t("artifact.whiteBlue") },
      { value: "advanced", label: t("artifact.gold") },
      { value: "superior", label: t("artifact.purple") },
      { value: "advanced_superior", label: t("artifact.goldPurple") },
      { value: "primary_normal_advanced_superior", label: t("artifact.all") },
    ],
    3: [
      { value: "advanced", label: t("artifact.gold") },
      { value: "superior", label: t("artifact.purple") },
      { value: "advanced_superior", label: t("artifact.goldPurple") },
    ],
  };
  return (
    <div className="space-y-6">
      <Tabs
        value={tab !== "global" && Number(tab.slice(5)) > draft.create_phase ? "global" : tab}
        onValueChange={setTab}
      >
        <TabsList className="flex w-full">
          <TabsTrigger value="global">{t("artifact.global")}</TabsTrigger>
          {Array.from({ length: draft.create_phase }, (_, index) => (
            <TabsTrigger key={index} value={`phase${index + 1}`}>
              {t(artifactPhaseKey(index + 1))}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="global">
          <ConfigurationGroup title={t("artifact.global")}>
            <ConfigurationToggle
              label={t("description.artifact.useTicket")}
              description={t("configurationHelp.artifactUseTicket")}
              checked={draft.use_acceleration_ticket}
              onChange={(value) =>
                setDraft((current) => ({ ...current, use_acceleration_ticket: value }))
              }
            />
            <ConfigurationInput
              label={t("artifact.createTime")}
              description={t("configurationHelp.artifactCreateTimes")}
              type="number"
              min={1}
              max={10}
              value={draft.createTime}
              aria-invalid={
                draft.createTime !== "" &&
                (!Number.isInteger(Number(draft.createTime)) ||
                  Number(draft.createTime) < 1 ||
                  Number(draft.createTime) > 10)
              }
              onChange={(event) =>
                setDraft((current) => ({ ...current, createTime: event.target.value }))
              }
            />
            <ConfigurationSelect
              label={t("artifact.phaseCount")}
              description={t("configurationHelp.artifactPhases")}
              value={String(draft.create_phase)}
              onChange={(value) =>
                setDraft((current) => ({ ...current, create_phase: Number(value) }))
              }
              options={[1, 2, 3].map((value) => ({ value: String(value), label: String(value) }))}
            />
          </ConfigurationGroup>
        </TabsContent>
        {Array.from({ length: draft.create_phase }, (_, index) => (index + 1) as 1 | 2 | 3).map(
          (phase) => {
            const methodKey = `create_phase_${phase}_select_item_rule` as const;
            const priorityKey = `createPriority_phase${phase}` as const;
            return (
              <TabsContent key={phase} value={`phase${phase}`}>
                <ConfigurationGroup title={t(artifactPhaseKey(phase))}>
                  <ConfigurationSelect
                    label={t("artifact.materialSelect")}
                    description={t("configurationHelp.artifactMaterialRule")}
                    value={draft[methodKey]}
                    onChange={(value) =>
                      setDraft((current) => ({ ...current, [methodKey]: value }))
                    }
                    options={methods[phase]}
                  />
                  {phase === 2 && (
                    <ConfigurationRow
                      label={t("artifact.phase2.recommend")}
                      description={t("configurationHelp.artifactRecommendedPriority")}
                    >
                      <button
                        type="button"
                        onClick={() => setStudentSelector(true)}
                        className="rounded-lg bg-secondary px-3 py-2 text-sm hover:bg-secondary/70"
                      >
                        {t("artifact.selectStudent")}
                      </button>
                    </ConfigurationRow>
                  )}
                  <ConfigurationRow
                    label={t("artifact.priority")}
                    description={t("friendlyPriority.reorderHint")}
                    className="configuration-row-stacked"
                  >
                    <PriorityListEditor
                      ariaLabel={t("artifact.priority")}
                      value={draft[priorityKey]}
                      options={
                        staticConfig.create_default_priority?.[serverMap[settings.server]]?.[
                          `phase${phase}`
                        ] ?? []
                      }
                      onChange={(value) =>
                        setDraft((current) => ({
                          ...current,
                          [priorityKey]: value,
                        }))
                      }
                    />
                  </ConfigurationRow>
                </ConfigurationGroup>
              </TabsContent>
            );
          }
        )}
      </Tabs>
      <StudentSelectorModal
        isOpen={studentSelector}
        onClose={() => setStudentSelector(false)}
        allStudents={Object.keys(staticConfig.create_phase2_recommended_priority ?? {})}
        selected={[]}
        onChange={(students) => {
          const name = students[0];
          if (!name) return;
          const indexes: number[] = staticConfig.create_phase2_recommended_priority?.[name] ?? [];
          const original: string[] =
            staticConfig.create_default_priority?.[serverMap[settings.server]]?.phase2 ?? [];
          const priority = [
            ...indexes
              .filter((index) => index >= 0 && index < original.length)
              .map((index) => original[index]),
            ...original.filter((_, index) => !indexes.includes(index)),
          ];
          setDraft((current) => ({ ...current, createPriority_phase2: priority }));
          setStudentSelector(false);
        }}
      />
    </div>
  );
};
export default ArtifactConfig;

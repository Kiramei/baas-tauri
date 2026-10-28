import React, { useCallback, useMemo, useState } from "react";
import { useAppTranslation } from "@/shared/useAppTranslation";
import {
  ConfigurationGroup,
  ConfigurationRow,
  ConfigurationSelect,
} from "@/components/configuration/ConfigurationControls";
import { FormInput } from "@/components/ui/FormInput";
import { FormSelect } from "@/components/ui/FormSelect";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { useWebSocketStore } from "@/store/WebsocketStore";
import StudentSelectorModal from "@/components/StudentSelectorModal";
import { useConfigurationDraft } from "@/shared/useConfigurationDraft";
import {
  ActivitySweepCountEditor,
  SweepCountEditor,
} from "@/components/configuration/SweepCountEditor";
import { isActivitySweepCountStringValid, isSweepCountStringValid } from "@/shared/SweepCounts";
import { appendSweepStages, isSweepPlanValid } from "@/shared/SweepPlan";
import SweepPlanEditor from "@/components/configuration/SweepPlanEditor";
import { serverMap } from "@/shared/GlobalUtilities";
import {
  isRewardedTaskCount,
  readRewardedTaskCounts,
  serializeRewardedTaskCounts,
} from "@/features/rewardedTaskConfig";

interface DailySweepTabsProps {
  profileId: string;
  onClose: () => void;
}
type Draft = {
  mainlinePriority: string;
  hardPriority: string;
  rewardedCounts: string[];
  scrimmage_times: string;
  activity_sweep_task_number: number | "";
  activity_sweep_times: string;
  special_task_times: string;
  purchase_rewarded_task_ticket_times: string;
  purchase_lesson_ticket_times: string;
  purchase_scrimmage_ticket_times: string;
};

/** Sweep targets and region counts remain one undoable, automatically saved draft. */
const DailySweepTabs: React.FC<DailySweepTabsProps> = ({ profileId }) => {
  const { t } = useAppTranslation();
  const settings = useWebSocketStore((state) => state.configStore[profileId]);
  const staticConfig = useWebSocketStore((state) => state.staticStore);
  const server = serverMap[settings.server];
  const normalMaximum = staticConfig.explore_normal_task_region_range?.[1];
  const hardMaximum = staticConfig.explore_hard_task_region_range?.[1];
  const activity = staticConfig.current_game_activity?.[server];
  const activityStages = useMemo<number[]>(() => {
    const missions = activity?.mission;
    if (!missions || typeof missions !== "object") return [];
    if (Array.isArray(missions)) return missions.map((_, index) => index + 1);
    return [
      ...new Set(
        Object.keys(missions).flatMap((key) => {
          const match = /^(?:任务|mission)?\s*(\d+)$/i.exec(key);
          const number = match ? Number(match[1]) : NaN;
          return Number.isSafeInteger(number) && number > 0 ? [number] : [];
        })
      ),
    ].sort((left, right) => left - right);
  }, [activity]);
  const materials: string[][] = useWebSocketStore(
    (state) => state.staticStore.hard_task_student_material ?? []
  );
  const [showStudents, setShowStudents] = useState(false);
  const ext = useMemo<Draft>(
    () => ({
      mainlinePriority: settings.mainlinePriority ?? "",
      hardPriority: settings.hardPriority ?? "",
      rewardedCounts: readRewardedTaskCounts(settings.rewarded_task_times, settings.server),
      scrimmage_times: settings.scrimmage_times ?? "0,0,0",
      activity_sweep_task_number: settings.activity_sweep_task_number ?? 1,
      activity_sweep_times: settings.activity_sweep_times ?? "0",
      special_task_times: settings.special_task_times ?? "0,0",
      purchase_rewarded_task_ticket_times: settings.purchase_rewarded_task_ticket_times ?? "0",
      purchase_lesson_ticket_times: settings.purchase_lesson_ticket_times ?? "0",
      purchase_scrimmage_ticket_times: settings.purchase_scrimmage_ticket_times ?? "0",
    }),
    [settings]
  );
  const serialize = useCallback(
    (draft: Draft) => {
      const { rewardedCounts, ...fields } = draft;
      const rewarded_task_times = serializeRewardedTaskCounts(rewardedCounts, settings.server);
      return rewarded_task_times === null ||
        fields.activity_sweep_task_number === "" ||
        (fields.mainlinePriority !== ext.mainlinePriority &&
          !isSweepPlanValid(fields.mainlinePriority, {
            mode: "normal",
            server,
            maxChapter: normalMaximum,
          })) ||
        (fields.hardPriority !== ext.hardPriority &&
          !isSweepPlanValid(fields.hardPriority, {
            mode: "hard",
            server,
            maxChapter: hardMaximum,
          })) ||
        (fields.scrimmage_times !== ext.scrimmage_times &&
          !isSweepCountStringValid(fields.scrimmage_times, 3)) ||
        (fields.special_task_times !== ext.special_task_times &&
          !isSweepCountStringValid(fields.special_task_times, 2)) ||
        (fields.activity_sweep_times !== ext.activity_sweep_times &&
          !isActivitySweepCountStringValid(fields.activity_sweep_times))
        ? null
        : { ...fields, rewarded_task_times };
    },
    [
      settings.server,
      server,
      normalMaximum,
      hardMaximum,
      ext.mainlinePriority,
      ext.hardPriority,
      ext.scrimmage_times,
      ext.special_task_times,
      ext.activity_sweep_times,
    ]
  );
  const [draft, setDraft] = useConfigurationDraft(profileId, "dailySweep", ext, { serialize });
  const invalidCounts = draft.rewardedCounts.some((value) => !isRewardedTaskCount(value));
  const purchaseOptions = (maximum: number) =>
    ["max", ...Array.from({ length: maximum + 1 }, (_, index) => String(index))].map((value) => ({
      value,
      label:
        value === "max"
          ? t("configurationCounts.maximumPurchases")
          : value === "0"
            ? t("configurationCounts.skip")
            : value,
    }));
  return (
    <div className="space-y-6">
      <Tabs defaultValue="daily">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="daily">{t("stage.dailyTab")}</TabsTrigger>
          <TabsTrigger value="sweep">{t("stage.sweepTab")}</TabsTrigger>
        </TabsList>
        <TabsContent value="daily">
          <ConfigurationGroup title={t("stage.dailyTab")}>
            <ConfigurationRow
              label={t("stage.normalLabel")}
              description={t("configurationHelp.normalSweepPlan")}
              className="configuration-row-stacked"
            >
              <SweepPlanEditor
                value={draft.mainlinePriority}
                mode="normal"
                server={server}
                maxChapter={normalMaximum}
                ariaLabel={t("stage.normalLabel")}
                onChange={(value) =>
                  setDraft((current) => ({ ...current, mainlinePriority: value }))
                }
              />
            </ConfigurationRow>
            <ConfigurationRow
              label={t("stage.hardLabel")}
              description={t("configurationHelp.hardSweepPlan")}
              className="configuration-row-stacked"
            >
              <div className="min-w-0 space-y-3">
                <SweepPlanEditor
                  value={draft.hardPriority}
                  mode="hard"
                  server={server}
                  maxChapter={hardMaximum}
                  ariaLabel={t("stage.hardLabel")}
                  onChange={(value) => setDraft((current) => ({ ...current, hardPriority: value }))}
                />
                <button
                  type="button"
                  onClick={() => setShowStudents(true)}
                  className="shrink-0 rounded-lg bg-secondary px-3 py-2 text-sm hover:bg-secondary/70"
                >
                  {t("stage.selectStudent")}
                </button>
              </div>
            </ConfigurationRow>
          </ConfigurationGroup>
        </TabsContent>
        <TabsContent value="sweep" className="space-y-6">
          <ConfigurationGroup title={t("sweep.rewarded")}>
            <SweepCountEditor
              value={draft.rewardedCounts.join(",")}
              labels={
                draft.rewardedCounts.length === 3
                  ? [
                      t("configurationCounts.bountyOverpass"),
                      t("configurationCounts.bountyRailroad"),
                      t("configurationCounts.bountyClassroom"),
                    ]
                  : draft.rewardedCounts.map((_, index) =>
                      t("sweep.rewardedRegion", { number: index + 1 })
                    )
              }
              onChange={(value) =>
                setDraft((current) => ({
                  ...current,
                  rewardedCounts: value.split(","),
                }))
              }
            />
            {invalidCounts && (
              <p role="alert" className="px-4 py-3 text-sm text-destructive">
                {t("sweep.rewardedInvalid")}
              </p>
            )}
          </ConfigurationGroup>
          <ConfigurationGroup title={t("sweep.scrimmage")}>
            <SweepCountEditor
              value={draft.scrimmage_times}
              labels={[
                t("configurationCounts.scrimmageTrinity"),
                t("configurationCounts.scrimmageGehenna"),
                t("configurationCounts.scrimmageMillennium"),
              ]}
              onChange={(value) => setDraft((current) => ({ ...current, scrimmage_times: value }))}
            />
          </ConfigurationGroup>
          <ConfigurationGroup title={t("sweep.special")}>
            <SweepCountEditor
              value={draft.special_task_times}
              labels={[
                t("configurationCounts.specialDefense"),
                t("configurationCounts.specialRetrieval"),
              ]}
              onChange={(value) =>
                setDraft((current) => ({ ...current, special_task_times: value }))
              }
            />
          </ConfigurationGroup>
          <ConfigurationGroup title={t("sweep.activityTimes")}>
            <ActivitySweepCountEditor
              value={draft.activity_sweep_times}
              stages={draft.activity_sweep_task_number}
              stagePicker={
                activityStages.length > 0 ? (
                  <FormSelect
                    ariaLabel={t("sweep.activityNumber")}
                    value={String(draft.activity_sweep_task_number)}
                    onChange={(value) =>
                      setDraft((current) => ({
                        ...current,
                        activity_sweep_task_number: Number(value),
                      }))
                    }
                    options={[
                      ...activityStages.map((number) => ({
                        value: String(number),
                        label: t("friendlyBounty.activityStageOption", { number }),
                      })),
                      ...(draft.activity_sweep_task_number !== "" &&
                      !activityStages.includes(draft.activity_sweep_task_number)
                        ? [
                            {
                              value: String(draft.activity_sweep_task_number),
                              label: t("friendlyBounty.activityStageSaved", {
                                number: draft.activity_sweep_task_number,
                              }),
                            },
                          ]
                        : []),
                    ]}
                  />
                ) : (
                  <FormInput
                    aria-label={t("sweep.activityNumber")}
                    type="number"
                    min={1}
                    step={1}
                    value={draft.activity_sweep_task_number}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (value === "" || Number.isFinite(Number(value)))
                        setDraft((current) => ({
                          ...current,
                          activity_sweep_task_number:
                            value === "" ? "" : Math.max(1, Math.trunc(Number(value))),
                        }));
                    }}
                  />
                )
              }
              onChange={(value) =>
                setDraft((current) => ({ ...current, activity_sweep_times: value }))
              }
            />
          </ConfigurationGroup>
          <ConfigurationGroup title={t("configurationHelp.sweepTicketsTitle")}>
            <ConfigurationSelect
              label={t("sweep.purchaseRewarded")}
              description={t("configurationHelp.sweepPurchaseRewarded")}
              value={draft.purchase_rewarded_task_ticket_times}
              onChange={(value) =>
                setDraft((current) => ({ ...current, purchase_rewarded_task_ticket_times: value }))
              }
              options={purchaseOptions(12)}
            />
            <ConfigurationSelect
              label={t("sweep.purchaseLesson")}
              description={t("configurationHelp.sweepPurchaseLesson")}
              value={draft.purchase_lesson_ticket_times}
              onChange={(value) =>
                setDraft((current) => ({ ...current, purchase_lesson_ticket_times: value }))
              }
              options={purchaseOptions(4)}
            />
            <ConfigurationSelect
              label={t("sweep.purchaseScrimmage")}
              description={t("configurationHelp.sweepPurchaseScrimmage")}
              value={draft.purchase_scrimmage_ticket_times}
              onChange={(value) =>
                setDraft((current) => ({ ...current, purchase_scrimmage_ticket_times: value }))
              }
              options={purchaseOptions(12)}
            />
          </ConfigurationGroup>
        </TabsContent>
      </Tabs>
      <StudentSelectorModal
        isOpen={showStudents}
        onClose={() => setShowStudents(false)}
        allStudents={Array.from(new Set(materials.map(([, name]) => name)))}
        selected={[]}
        onChange={(names) => {
          const stages = materials
            .filter(([, name]) => names.includes(name))
            .map(([stage]) => stage);
          if (stages.length)
            setDraft((current) => ({
              ...current,
              hardPriority: appendSweepStages(current.hardPriority, stages),
            }));
          setShowStudents(false);
        }}
      />
    </div>
  );
};
export default DailySweepTabs;

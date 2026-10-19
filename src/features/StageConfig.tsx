import React, { type Dispatch, type SetStateAction, useMemo } from "react";
import { Play } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import {
  ConfigurationGroup,
  ConfigurationRow,
  ConfigurationToggle,
} from "@/components/configuration/ConfigurationControls";
import { ExplorePlanEditor } from "@/components/configuration/ExplorePlanEditor";
import { useAppTranslation } from "@/shared/useAppTranslation";
import { useWebSocketStore } from "@/store/WebsocketStore";
import { useConfigurationDraft } from "@/shared/useConfigurationDraft";
import { getTimestampMs, serverMap } from "@/shared/GlobalUtilities";
import { toast } from "sonner";
import type { PageKey } from "@/types/app";
import { eventNameKey, propertyKey } from "@/shared/I18nKeys";
import "@/components/configuration/configuration-forms.css";

interface StageConfigProps {
  profileId: string;
  onClose: () => void;
  setActivePage?: Dispatch<SetStateAction<PageKey>>;
}
interface Draft {
  manual_boss: boolean;
  explore_normal_task_list: string;
  explore_hard_task_list: string;
}
const StageConfig: React.FC<StageConfigProps> = ({ profileId, setActivePage, onClose }) => {
  const { t } = useAppTranslation();
  const staticConfig = useWebSocketStore((state) => state.staticStore);
  const settings = useWebSocketStore((state) => state.configStore[profileId]);
  const trigger = useWebSocketStore((state) => state.trigger);
  const initial = useMemo<Draft>(
    () => ({
      manual_boss: settings.manual_boss ?? false,
      explore_normal_task_list: settings.explore_normal_task_list ?? "",
      explore_hard_task_list: settings.explore_hard_task_list ?? "",
    }),
    [settings]
  );
  const [draft, setDraft, flush] = useConfigurationDraft(profileId, "stage", initial);
  const event = staticConfig.current_game_activity?.[serverMap[settings.server]];
  const eventName = event?.activity_name ?? t("stage.noEvent");
  const eventTable = useMemo(() => {
    const result: [string, string][] = [];
    (["story", "mission", "challenge"] as const).forEach((type) => {
      Object.entries(event?.[type] ?? {}).forEach(([name, property]) =>
        result.push([name, String(property)])
      );
    });
    return result;
  }, [event]);
  const handleTrigger = (task: string) => () => {
    if (task === "start_hard_task" && !String(draft.explore_hard_task_list ?? "").trim()) {
      toast.error(t("stage.noHardTask"));
      return;
    }
    if (task === "start_normal_task" && !String(draft.explore_normal_task_list ?? "").trim()) {
      toast.error(t("stage.noNormalTask"));
      return;
    }
    flush();
    trigger(
      { timestamp: getTimestampMs(), command: "solve", config_id: profileId, payload: { task } },
      () => {
        toast(t("stage.taskTriggerStart"), {
          description: t("stage.taskTriggered", { task: t(eventNameKey(task)) }),
        });
      }
    );
    onClose();
    setActivePage?.("home");
  };
  const execute = (label: string, task: string) => (
    <button key={task} type="button" className="stage-task-action" onClick={handleTrigger(task)}>
      <span>{label}</span>
      <Play size={14} aria-hidden="true" />
    </button>
  );

  return (
    <Tabs defaultValue="explore" className="w-full">
      <TabsList className="mb-5 w-full">
        <TabsTrigger value="explore">{t("stage.exploreTab")}</TabsTrigger>
        <TabsTrigger value="event">{t("stage.eventTab")}</TabsTrigger>
      </TabsList>
      <TabsContent value="explore" className="space-y-7">
        <ConfigurationGroup title={t("stage.exploreTab")}>
          <ConfigurationToggle
            label={t("stage.manualBoss")}
            description={t("configurationHelp.manualBoss")}
            checked={draft.manual_boss}
            onChange={(value) => setDraft((previous) => ({ ...previous, manual_boss: value }))}
          />
          <div className="stage-plan-section">
            <div className="stage-plan-heading">
              <div className="settings-label">{t("stage.normalTask")}</div>
              <button
                type="button"
                className="configuration-action"
                aria-label={`${t("common.execute")}: ${t("stage.normalTask")}`}
                onClick={handleTrigger("start_normal_task")}
              >
                <Play size={13} aria-hidden="true" />
                {t("common.execute")}
              </button>
            </div>
            <ExplorePlanEditor
              ariaLabel={t("stage.normalTask")}
              mode="normal"
              chapterRange={staticConfig.explore_normal_task_region_range}
              maxChapter={staticConfig.max_region?.[serverMap[settings.server]]}
              value={draft.explore_normal_task_list}
              onChange={(value) =>
                setDraft((previous) => ({
                  ...previous,
                  explore_normal_task_list: value,
                }))
              }
            />
          </div>
          <div className="stage-plan-section">
            <div className="stage-plan-heading">
              <div className="settings-label">{t("stage.hardTask")}</div>
              <button
                type="button"
                className="configuration-action"
                aria-label={`${t("common.execute")}: ${t("stage.hardTask")}`}
                onClick={handleTrigger("start_hard_task")}
              >
                <Play size={13} aria-hidden="true" />
                {t("common.execute")}
              </button>
            </div>
            <ExplorePlanEditor
              ariaLabel={t("stage.hardTask")}
              mode="hard"
              chapterRange={staticConfig.explore_hard_task_region_range}
              maxChapter={staticConfig.max_region?.[serverMap[settings.server]]}
              value={draft.explore_hard_task_list}
              onChange={(value) =>
                setDraft((previous) => ({
                  ...previous,
                  explore_hard_task_list: value,
                }))
              }
            />
          </div>
        </ConfigurationGroup>
        <ConfigurationGroup title={t("stage.story")}>
          <div className="stage-task-actions">
            {execute(t("stage.story.main"), "start_main_story")}
            {execute(t("stage.story.group"), "start_group_story")}
            {execute(t("stage.story.mini"), "start_mini_story")}
          </div>
        </ConfigurationGroup>
      </TabsContent>
      <TabsContent value="event" className="space-y-7">
        <ConfigurationGroup title={t("stage.eventTab")}>
          <ConfigurationRow label={t("stage.currentEvent")} className="stage-event-name">
            <span className="text-sm">{eventName}</span>
          </ConfigurationRow>
          <div className="stage-task-actions">
            {execute(t("stage.story"), "start_explore_activity_story")}
            {execute(t("stage.mission"), "start_explore_activity_mission")}
            {execute(t("stage.challenge"), "start_explore_activity_challenge")}
          </div>
        </ConfigurationGroup>
        {eventTable.length > 0 && (
          <ConfigurationGroup title={t("stage.attrTable")}>
            <dl className="stage-attribute-grid">
              {eventTable.map(([stage, attribute], index) => (
                <div key={stage + index}>
                  <dt>{stage}</dt>
                  <dd>{t(propertyKey(attribute))}</dd>
                </div>
              ))}
            </dl>
          </ConfigurationGroup>
        )}
      </TabsContent>
    </Tabs>
  );
};
export default StageConfig;

import React, {
  type Dispatch,
  type SetStateAction,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { LoaderCircle, Play } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import {
  ConfigurationGroup,
  ConfigurationRow,
  ConfigurationToggle,
} from "@/components/configuration/ConfigurationControls";
import { ExplorePlanEditor } from "@/components/configuration/ExplorePlanEditor";
import { FormInput } from "@/components/ui/FormInput";
import { OrderedMultiSelector } from "@/components/MultiSelector";
import { useAppTranslation } from "@/shared/useAppTranslation";
import { useWebSocketStore } from "@/store/WebsocketStore";
import { useConfigurationDraft } from "@/shared/useConfigurationDraft";
import { serverMap } from "@/shared/GlobalUtilities";
import { toast } from "sonner";
import type { PageKey } from "@/types/app";
import { eventNameKey, propertyKey } from "@/shared/I18nKeys";
import {
  mainStoryEpisodeOptions,
  hasConfigurationField,
  parseMainStoryRegions,
  readMainStoryRegions,
  runStageTaskAfterSave,
  serializeStageConfig,
  StageLaunchError,
  type StageConfigDraft,
} from "./upstreamConfig";
import "@/components/configuration/configuration-forms.css";

interface StageConfigProps {
  profileId: string;
  onClose: () => void;
  setActivePage?: Dispatch<SetStateAction<PageKey>>;
}
const StageConfig: React.FC<StageConfigProps> = ({ profileId, setActivePage, onClose }) => {
  const { t } = useAppTranslation();
  const staticConfig = useWebSocketStore((state) => state.staticStore);
  const settings = useWebSocketStore((state) => state.configStore[profileId]);
  const supportsSimpleMode = hasConfigurationField(settings, "explore_task_use_simple_mode");
  const supportsStorySelection = hasConfigurationField(settings, "main_story_regions");
  const [pending, setPending] = useState<{ profileId: string; task: string } | null>(null);
  const pendingTask = pending?.profileId === profileId ? pending.task : null;
  const pendingAction = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      const controller = pendingAction.current;
      pendingAction.current = null;
      controller?.abort();
    },
    [profileId]
  );
  const storyErrorId = useId();
  const availableEpisodes = useMemo(
    () =>
      mainStoryEpisodeOptions(
        staticConfig.main_story_available_episodes?.[serverMap[settings.server]]
      ),
    [staticConfig.main_story_available_episodes, settings.server]
  );
  const initial = useMemo<StageConfigDraft>(
    () => ({
      manual_boss: settings.manual_boss ?? false,
      explore_task_use_simple_mode: settings.explore_task_use_simple_mode ?? false,
      explore_normal_task_list: settings.explore_normal_task_list ?? "",
      explore_hard_task_list: settings.explore_hard_task_list ?? "",
      main_story_regions: readMainStoryRegions(settings.main_story_regions),
    }),
    [settings]
  );
  const [draft, setDraft, flush] = useConfigurationDraft(profileId, "stage", initial, {
    serialize: (value) => serializeStageConfig(value, availableEpisodes, settings),
  });
  const storySelection = parseMainStoryRegions(draft.main_story_regions, availableEpisodes);
  const storyError = !supportsStorySelection
    ? null
    : storySelection.error === "format"
      ? t("stage.mainStoryInvalidEpisodes")
      : storySelection.error === "unavailable"
        ? availableEpisodes.length
          ? t("stage.mainStoryUnavailableEpisodes", { episodes: availableEpisodes.join(", ") })
          : t("stage.mainStoryCatalogPending")
        : null;
  const storyValues = [
    ...new Set(
      draft.main_story_regions
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    ),
  ];
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
  const handleTrigger = async (task: string) => {
    if (pendingAction.current) return;
    if (task === "start_main_story" && storyError) {
      toast.error(storyError);
      return;
    }
    if (task === "start_hard_task" && !String(draft.explore_hard_task_list ?? "").trim()) {
      toast.error(t("stage.noHardTask"));
      return;
    }
    if (task === "start_normal_task" && !String(draft.explore_normal_task_list ?? "").trim()) {
      toast.error(t("stage.noNormalTask"));
      return;
    }
    const controller = new AbortController();
    pendingAction.current = controller;
    setPending({ profileId, task });
    try {
      const result = await runStageTaskAfterSave(
        useWebSocketStore.getState,
        profileId,
        task,
        serializeStageConfig(draft, availableEpisodes, settings),
        flush,
        { signal: controller.signal }
      );
      if (!controller.signal.aborted) {
        if (result === "already-running") {
          toast.info(t("stage.executionAlreadyRunning"));
          return;
        }
        toast(t("stage.taskTriggerStart"), {
          description: t("stage.taskTriggered", { task: t(eventNameKey(task)) }),
        });
        onClose();
        setActivePage?.("home");
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      toast.error(
        error instanceof StageLaunchError && error.code === "session_changed"
          ? t("stage.executionSessionChanged")
          : error instanceof StageLaunchError && error.code === "command_unconfirmed"
            ? t("stage.executionFailed")
            : t("stage.executionSaveUnconfirmed")
      );
    } finally {
      if (pendingAction.current === controller) {
        pendingAction.current = null;
        setPending(null);
      }
    }
  };
  const execute = (label: string, task: string) => (
    <button
      key={task}
      type="button"
      className="stage-task-action disabled:opacity-40"
      disabled={pendingTask !== null || (task === "start_main_story" && Boolean(storyError))}
      onClick={() => void handleTrigger(task)}
    >
      <span>{label}</span>
      {pendingTask === task ? (
        <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
      ) : (
        <Play size={14} aria-hidden="true" />
      )}
    </button>
  );

  return (
    <div aria-busy={pendingTask !== null}>
      {pendingTask !== null ? (
        <p role="status" className="mb-4 text-sm text-muted-foreground">
          {t("stage.executionPreparing")}
        </p>
      ) : null}
      <fieldset disabled={pendingTask !== null} className="min-w-0">
        <Tabs defaultValue="explore" className="w-full">
          <TabsList className="mb-5 w-full">
            <TabsTrigger value="explore">{t("stage.exploreTab")}</TabsTrigger>
            <TabsTrigger value="event">{t("stage.eventTab")}</TabsTrigger>
          </TabsList>
          <TabsContent value="explore" className="space-y-7">
            <ConfigurationGroup title={t("stage.exploreTab")}>
              <ConfigurationToggle
                label={t("stage.simpleMode")}
                description={
                  supportsSimpleMode
                    ? t("configurationHelp.exploreSimpleMode")
                    : t("configurationHelp.backendUpdateRequired")
                }
                disabled={!supportsSimpleMode}
                checked={draft.explore_task_use_simple_mode}
                onChange={(value) =>
                  setDraft((previous) => ({ ...previous, explore_task_use_simple_mode: value }))
                }
              />
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
                    disabled={pendingTask !== null}
                    onClick={() => void handleTrigger("start_normal_task")}
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
                    disabled={pendingTask !== null}
                    onClick={() => void handleTrigger("start_hard_task")}
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
              <ConfigurationRow
                label={t("stage.mainStoryEpisodes")}
                description={
                  supportsStorySelection
                    ? t("configurationHelp.mainStoryEpisodes")
                    : t("configurationHelp.backendUpdateRequired")
                }
                className="configuration-row-stacked"
              >
                <fieldset disabled={!supportsStorySelection} className="min-w-0 space-y-3">
                  <OrderedMultiSelector
                    values={storyValues}
                    alternatives={availableEpisodes.map(String)}
                    onChange={(values: string[]) =>
                      supportsStorySelection &&
                      setDraft((previous) => ({
                        ...previous,
                        main_story_regions: values.join(","),
                      }))
                    }
                  />
                  <FormInput
                    aria-label={t("stage.mainStoryEpisodeList")}
                    aria-invalid={Boolean(storyError)}
                    aria-describedby={storyError ? storyErrorId : undefined}
                    value={draft.main_story_regions}
                    onChange={(event) =>
                      setDraft((previous) => ({
                        ...previous,
                        main_story_regions: event.target.value,
                      }))
                    }
                    placeholder={t("stage.mainStoryAllEpisodes")}
                    spellCheck={false}
                  />
                  {storyError ? (
                    <p id={storyErrorId} role="alert" className="text-xs text-destructive">
                      {storyError}
                    </p>
                  ) : !storySelection.value ? (
                    <p className="text-xs text-muted-foreground">
                      {t("stage.mainStoryAllEpisodes")}
                    </p>
                  ) : null}
                </fieldset>
              </ConfigurationRow>
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
      </fieldset>
    </div>
  );
};
export default StageConfig;

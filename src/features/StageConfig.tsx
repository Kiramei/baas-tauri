import React, {Dispatch, SetStateAction, useEffect, useMemo, useState} from "react";
import {Tabs, TabsContent, TabsList, TabsTrigger} from "@/components/ui/tabs";
import {FormInput} from "@/components/ui/FormInput";
import SwitchButton from "@/components/ui/SwitchButton";
import CButton from "@/components/ui/CButton.tsx";
import {Card} from "@/components/ui/Card";
import {useTranslation} from "react-i18next";
import {Separator} from "@/components/ui/separator.tsx";
import {useWebSocketStore} from "@/store/websocketStore.ts";
import {DynamicConfig} from "@/types/dynamic";
import {getTimestampMs, serverMap} from "@/lib/utils.ts";
import {toast} from "sonner";
import {PageKey} from "@/types/app";

type StageConfigProps = {
  profileId: string;
  onClose: () => void;
  setActivePage?: Dispatch<SetStateAction<PageKey>>;
};


interface Draft {
  manual_boss: boolean;
  explore_normal_task_list: string;
  explore_hard_task_list: string;
}

const StageConfig: React.FC<StageConfigProps> = (
    {
      profileId,
      setActivePage,
      onClose
    }
  ) => {
    const {t} = useTranslation();

    const staticConfig = useWebSocketStore(state => state.staticStore);
    const settings: Partial<DynamicConfig> = useWebSocketStore(state => state.configStore[profileId]);
    const modify = useWebSocketStore(state => state.modify);
    const trigger = useWebSocketStore(state => state.trigger);

    const ext = useMemo<Draft>(() => {
      return {
        manual_boss: settings.manual_boss,
        explore_normal_task_list: settings.explore_normal_task_list,
        explore_hard_task_list: settings.explore_hard_task_list,
      } as Draft;
    }, [settings]);

    const [draft, setDraft] = useState<Draft>(ext);
    const dirty = JSON.stringify(draft) !== JSON.stringify(ext);

    const [eventTable, setEventTable] = useState<[string, string][]>([]);

    const serverKey = serverMap[settings.server!];
    const event = staticConfig.current_game_activity[serverKey];
    const eventName = event?.activity_name ?? t("stage.noEvent");

    useEffect(() => {
      if (!event) return;
      const result: [string, string][] = [];
      (["story", "mission", "challenge"] as const).forEach((type) => {
        const section = event[type];
        if (!section) return;
        Object.entries(section).forEach(([name, prop]) => {
          result.push([name, prop as string]);
        });
      });
      setEventTable(result);
    }, [event]);


    const handleSave = async () => {
      const patch: Partial<DynamicConfig> = {};
      (Object.keys(draft) as (keyof Draft)[]).forEach((k) => {
        if (JSON.stringify(draft[k]) !== JSON.stringify(ext[k])) {
          (patch as any)[k] = draft[k];
        }
      });

      if (Object.keys(patch).length === 0) {
        onClose();
        return;
      }
      modify(`${profileId}::config`, patch)

      onClose();
    }


    const handleChange = (key: keyof Draft) => (value: any) => {
      setDraft(prev => ({...prev, [key]: value}));
    }

    const handleTrigger = (taskName: string) => async () => {
      if (taskName === "start_hard_task" || taskName === "start_normal_task") {
        if (taskName === "start_hard_task" && (!draft.explore_hard_task_list || draft.explore_hard_task_list.trim() === "")) {
          toast.error(t("stage.noHardTask"));
          return;
        } else if (taskName === "start_normal_task" && (!draft.explore_normal_task_list || draft.explore_normal_task_list.trim() === "")) {
          toast.error(t("stage.noNormalTask"));
          return;
        }
        await handleSave();
      }
      trigger({
        timestamp: getTimestampMs(),
        command: "solve",
        config_id: profileId,
        payload: {
          task: taskName,
        }
      }, () => {
        toast(t("stage.taskTriggerStart"), {
          description: t("stage.taskTriggered", {task: t(taskName)}),
        })
      });
      onClose();
      setActivePage?.("home")
    }


    return (
      <div>
        <Tabs defaultValue="explore" className="w-full">
          <TabsList className="w-full">
            <TabsTrigger value="explore">{t("stage.exploreTab")}</TabsTrigger>
            <TabsTrigger value="event">{t("stage.eventTab")}</TabsTrigger>
          </TabsList>

          {/* 普通推图 */}
          <TabsContent value="explore" className="space-y-2">
            <SwitchButton
              label={t("stage.manualBoss")}
              checked={draft.manual_boss}
              onChange={handleChange("manual_boss")}
              className="w-full"
            />

            <div className="flex gap-2 w-full">
              <CButton className="flex-1" onClick={handleTrigger("start_main_story")}>{t("stage.story.main")}</CButton>
              <CButton className="flex-1" onClick={handleTrigger("start_group_story")}>{t("stage.story.group")}</CButton>
              <CButton className="flex-1" onClick={handleTrigger("start_mini_story")}>{t("stage.story.mini")}</CButton>
            </div>


            <Separator/>

            <div className="w-full flex flex-row gap-2 items-end">
              <FormInput
                label={t("stage.normalTask")}
                value={draft.explore_normal_task_list}
                onChange={(e) => handleChange("explore_normal_task_list")(e.target.value)}
                placeholder={t("placeholder.config.insert")}
                className="flex-1"
              />
              <CButton
                onClick={handleTrigger("start_normal_task")}
                className="h-9"
              >
                {t("execute")}
              </CButton>
            </div>

            <div className="w-full flex flex-row gap-2 items-end">
              <FormInput
                label={t("stage.hardTask")}
                value={draft.explore_hard_task_list}
                onChange={(e) => handleChange("explore_hard_task_list")(e.target.value)}
                placeholder={t("placeholder.config.insert")}
                className="flex-1"
              />

              <CButton
                onClick={handleTrigger("start_hard_task")}
                className="h-9"
              >
                {t("execute")}
              </CButton>
            </div>

          </TabsContent>

          {/* 活动推图 */}
          <TabsContent value="event" className="space-y-4">
            <Card className="p-3">
              <p className="text-sm">
                {t("stage.currentEvent")}: <b>{eventName}</b>
              </p>
            </Card>

            <div className="flex gap-2 w-full">
              <CButton className="flex-1"
                       onClick={handleTrigger("start_explore_activity_story")}>{t("stage.story")}</CButton>
              <CButton className="flex-1"
                       onClick={handleTrigger("start_explore_activity_mission")}>{t("stage.mission")}</CButton>
              <CButton className="flex-1"
                       onClick={handleTrigger("start_explore_activity_challenge")}>{t("stage.challenge")}</CButton>
            </div>

            <div>
              <p className="mb-2">{t("stage.attrTable")}</p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
                {eventTable.map(([stage, attr], i) => (
                  <Card key={i} className="p-2 flex justify-between">
                    <span>{stage}</span>
                    <span className="font-medium">{t(`property.${attr}`)}</span>
                  </Card>
                ))}
              </div>
            </div>
          </TabsContent>
        </Tabs>

        {/* Save Button */}
        <div className="flex justify-end pt-4 border-t border-slate-200 dark:border-slate-700 mt-4">
          <button
            onClick={handleSave}
            disabled={!dirty}
            className="px-6 py-2 bg-primary-600 text-white font-semibold rounded-lg hover:bg-primary-700 transition-colors duration-200 disabled:opacity-60"
          >
            {t("save")}
          </button>
        </div>
      </div>
    );
  }
;

export default StageConfig;

import React, {useMemo, useState} from "react";
import {useTranslation} from "react-i18next";
import {Tabs, TabsContent, TabsList, TabsTrigger} from "@/components/ui/tabs";
import {FormSelect} from "@/components/ui/FormSelect";
import {FormInput} from "@/components/ui/FormInput";
import {LabelWithTooltip} from "@/components/ui/LabelWithTooltip.tsx";
import {Separator} from "@/components/ui/separator.tsx";
import {useWebSocketStore} from "@/store/websocketStore.ts";
import {DynamicConfig} from "@/types/dynamic";
import CButton from "@/components/ui/CButton.tsx";
import StudentSelectorModal from "@/components/StudentSelectorModal.tsx";

interface DailySweepTabsProps {
  profileId: string;
  onClose: () => void;
}

type Draft = {
  mainlinePriority: string;
  hardPriority: string;
  rewarded_task_times: string;
  scrimmage_times: string;
  activity_sweep_task_number: number;
  activity_sweep_times: string;
  special_task_times: string;
  purchase_rewarded_task_ticket_times: string;
  purchase_lesson_ticket_times: string;
  purchase_scrimmage_ticket_times: string;
}

const DailySweepTabs: React.FC<DailySweepTabsProps> = ({profileId, onClose}) => {
  const {t} = useTranslation();

  const settings: Partial<DynamicConfig> = useWebSocketStore(state => state.configStore[profileId]);
  const modify = useWebSocketStore(state => state.modify);
  const staticConfig = useWebSocketStore(state => state.staticStore);
  const hard_task_student_material = staticConfig.hard_task_student_material as string [][]
  const [openStudentModal, setOpenStudentModal] = useState(false);

  const ext = useMemo(() => {
    return {
      mainlinePriority: settings.mainlinePriority!,
      hardPriority: settings.hardPriority!,
      rewarded_task_times: settings.rewarded_task_times!,
      scrimmage_times: settings.scrimmage_times!,
      activity_sweep_task_number: settings.activity_sweep_task_number!,
      activity_sweep_times: settings.activity_sweep_times!,
      special_task_times: settings.special_task_times!,
      purchase_rewarded_task_ticket_times: settings.purchase_rewarded_task_ticket_times!,
      purchase_lesson_ticket_times: settings.purchase_lesson_ticket_times!,
      purchase_scrimmage_ticket_times: settings.purchase_scrimmage_ticket_times!
    };
  }, []);

  const [draft, setDraft] = useState<Draft>(ext);

  const getStagesByName = (name: string): string[] => {
    return hard_task_student_material
      .filter(([_, student]) => student === name)
      .map(([stage]) => stage);
  };

  const getUniqueNames = (): string[] => {
    return Array.from(
      new Set(hard_task_student_material.map(([_, name]) => name))
    );
  };

  const dirty = JSON.stringify(draft) !== JSON.stringify(ext);

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

  return (
    <div>
      <Tabs defaultValue="daily" className="w-full">
        <TabsList className="w-full">
          <TabsTrigger value="daily">{t("stage.dailyTab")}</TabsTrigger>
          <TabsTrigger value="sweep">{t("stage.sweepTab")}</TabsTrigger>
        </TabsList>

        {/* DailySweep Tab */}
        <TabsContent value="daily" className="space-y-4">
          <div>
            <LabelWithTooltip label={t("stage.normalLabel")} tooltip={t("stage.normalDesc")}/>
            <FormInput
              type="text"
              value={draft.mainlinePriority}
              onChange={(e) => setDraft({...draft, mainlinePriority: e.target.value})}
              placeholder={t("placeholder.config.insert")}
            />
          </div>

          <div>
            <LabelWithTooltip label={t("stage.hardLabel")} tooltip={t("stage.hardDesc")}/>
            <div className="flex gap-2">
              <FormInput
                type="text"
                value={draft.hardPriority}
                onChange={(e) => setDraft({...draft, hardPriority: e.target.value})}
                placeholder={t("placeholder.config.insert")}
                className='flex-1'
              />
              <CButton onClick={() => setOpenStudentModal(true)} variant={"secondary"}>
                {t("stage.selectStudent")}
              </CButton>
            </div>
          </div>

        </TabsContent>

        {/* SweepCountConfig Tab */}
        <TabsContent value="sweep" className="grid gap-2 grid-cols-1 md:grid-cols-2">
          <FormInput
            label={t("sweep.rewarded")}
            value={draft.rewarded_task_times}
            onChange={(e) => setDraft({...draft, rewarded_task_times: e.target.value})}
          />
          <FormInput
            label={t("sweep.scrimmage")}
            value={draft.scrimmage_times}
            onChange={(e) => setDraft({...draft, scrimmage_times: e.target.value})}
          />
          <FormInput
            label={t("sweep.activityNumber")}
            value={draft.activity_sweep_task_number}
            onChange={(e) => setDraft({...draft, activity_sweep_task_number: Number(e.target.value)})}
          />
          <FormInput
            label={t("sweep.activityTimes")}
            value={draft.activity_sweep_times}
            onChange={(e) => setDraft({...draft, activity_sweep_times: e.target.value})}
          />
          <FormInput
            label={t("sweep.special")}
            value={draft.special_task_times}
            onChange={(e) => setDraft({...draft, special_task_times: e.target.value})}
          />

          <FormSelect
            label={t("sweep.purchaseRewarded")}
            value={draft.purchase_rewarded_task_ticket_times}
            onChange={(v) => setDraft({...draft, purchase_rewarded_task_ticket_times: v})}
            options={["max", ...Array.from({length: 13}, (_, i) => i.toString())].map((x) => ({
              value: x,
              label: x,
            }))}
          />

          <FormSelect
            label={t("sweep.purchaseLesson")}
            value={draft.purchase_lesson_ticket_times}
            onChange={(v) => setDraft({...draft, purchase_lesson_ticket_times: v})}
            options={["max", "0", "1", "2", "3", "4"].map((x) => ({value: x, label: x}))}
          />

          <FormSelect
            label={t("sweep.purchaseScrimmage")}
            value={draft.purchase_scrimmage_ticket_times}
            onChange={(v) => setDraft({...draft, purchase_scrimmage_ticket_times: v})}
            options={["max", ...Array.from({length: 13}, (_, i) => i.toString())].map((x) => ({
              value: x,
              label: x,
            }))}
          />

        </TabsContent>
      </Tabs>

      <Separator className="mt-4"/>

      <div className="flex justify-end pt-4">
        <button
          onClick={handleSave}
          disabled={!dirty}
          className="px-6 py-2 bg-primary-600 text-white font-semibold rounded-lg hover:bg-primary-700 transition-colors duration-200 disabled:opacity-60"
        >
          {t("save")}
        </button>
      </div>

      <StudentSelectorModal
        isOpen={openStudentModal}
        onClose={function (): void {
          setOpenStudentModal(false);
        }}
        allStudents={getUniqueNames()}
        selected={[]}
        onChange={function (list: string[]): void {
          const stages = getStagesByName(list[0])
          setDraft(state => {
            const current = state.hardPriority ? state.hardPriority + ", " : "";
            return {...state, hardPriority: current + stages.join(", ")}
          })

          setOpenStudentModal(false)
        }}
      />
    </div>
  );
};

export default DailySweepTabs;

import React, {useState} from "react";
import {useTranslation} from "react-i18next";
import {Modal} from "@/components/ui/Modal";
import CButton from "@/components/ui/CButton.tsx";
import {FormInput} from "@/components/ui/FormInput.tsx";
import {Separator} from "@/components/ui/separator.tsx";
import {OrderedMultiSelector, TimeSelectorModal} from "@/components/MultiSelector.tsx";
import {EventConfig} from "@/types/event";
import {DateTimePicker} from "@/components/DateTimePicker.tsx";

interface FeatureSwitchModalProps {
  task: EventConfig;
  onClose: () => void;
  onSave: (task: EventConfig) => void;
  allTasks: string[];
}

const FeatureSwitchModal: React.FC<FeatureSwitchModalProps> = ({task, onClose, onSave, allTasks}) => {
  const {t} = useTranslation();
  const [form, setForm] = useState<EventConfig>({...task});

  const handleChange = (key: keyof EventConfig, value: any) => {
    setForm((prev) => ({...prev, [key]: value}));
  };

  const handleSave = () => {
    onSave(form);
  };

  return (
    <Modal isOpen={true} onClose={onClose} title={t("scheduler.detailConfig")} width={80}>
      <div className="space-y-2">
        {/* 事件名称（只读） */}
        <FormInput
          label={t("scheduler.eventName")}
          value={form.event_name} disabled
        />

        <label className="block text-sm font-medium">{t("scheduler.nextTick")}</label>

        <DateTimePicker
          value={task.next_tick * 1000}
          onChange={(ts) => handleChange("next_tick", Math.floor(ts / 1000))}
          className="w-full justify-center flex xl:hidden"
        />

        <div className="grid grid-cols-1 gap-y-2 lg:grid-cols-2 gap-2">

          {/* 优先级 */}
          <FormInput
            label={t("scheduler.priority")}
            type="number"
            value={form.priority ?? 0}
            onChange={(e) => handleChange("priority", Number(e.target.value))}
          />

          {/* 执行间隔 */}
          <FormInput
            label={t("scheduler.interval")}
            type="number"
            value={form.interval ?? 0}
            onChange={(e) => handleChange("interval", Number(e.target.value))}
            min={0}
          />


          {/* 每日重置 */}
          <TimeSelectorModal
            label={t("scheduler.dailyReset")}
            values={form.daily_reset ?? []}
            onChange={(newTimes) => {
              handleChange("daily_reset", newTimes)
            }}
            mode="time"
          />


          {/* 禁用时间段 */}
          <TimeSelectorModal
            label={t("scheduler.disabledRange")}
            values={form.disabled_time_range ?? []}
            onChange={(newRanges) => {
              handleChange("disabled_time_range", newRanges)
            }}
            mode="range"
          />

          {/* 前置任务 */}
          <OrderedMultiSelector
            label={t("scheduler.preTask")}
            values={form.pre_task ?? []}
            onChange={(newValues: any[]) => {
              setForm((d) => ({...d, pre_task: newValues}));
            }}
            alternatives={allTasks}
            translatePrefix="eventName"
          />

          {/* 后置任务 */}
          <OrderedMultiSelector
            label={t("scheduler.postTask")}
            values={form.post_task ?? []}
            onChange={(newValues: any[]) => {
              setForm((d) => ({...d, post_task: newValues}));
            }}
            alternatives={allTasks}
            translatePrefix="eventName"
          />
        </div>

        <Separator/>
        {/* 按钮 */}
        <div className="flex justify-end gap-2 pt-1">
          <CButton onClick={handleSave}>{t("common.confirm")}</CButton>
        </div>
      </div>
    </Modal>
  );
};

export default FeatureSwitchModal;

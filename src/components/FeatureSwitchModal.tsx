import React, { useState } from "react";
import { useAppTranslation as useTranslation } from "@/shared/useAppTranslation";
import { eventNameKey } from "@/shared/I18nKeys";
import { Modal } from "@/components/ui/Modal";
import CButton from "@/components/ui/CButton.tsx";
import { FormInput } from "@/components/ui/FormInput.tsx";
import { OrderedMultiSelector, TimeSelectorModal } from "@/components/MultiSelector.tsx";
import { EventConfig } from "@/types/event";
import { DateTimePicker } from "@/components/DateTimePicker.tsx";

interface FeatureSwitchModalProps {
  task: EventConfig;
  onClose: () => void;
  onSave: (task: EventConfig) => void;
  allTasks: string[];
}

/** Renders the feature switch modal component. */
const FeatureSwitchModal: React.FC<FeatureSwitchModalProps> = ({
  task,
  onClose,
  onSave,
  allTasks,
}) => {
  const { t } = useTranslation();
  const [form, setForm] = useState<EventConfig>({ ...task });
  const taskNameKey = eventNameKey(form.func_name);

  /** Handles the handle change interaction. */
  const handleChange = (key: keyof EventConfig, value: any) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  /** Handles the handle save interaction. */
  const handleSave = () => {
    onSave(form);
  };

  return (
    <Modal isOpen={true} onClose={onClose} title={t("scheduler.detailConfig")} width={80}>
      <div className="scheduler-task-editor space-y-2">
        {/* Event name (read-only) */}
        <FormInput
          label={t("scheduler.eventName")}
          value={
            taskNameKey === "eventName.unknown" ? form.event_name : t(eventNameKey(form.func_name))
          }
          disabled
        />

        <label className="block text-sm font-medium">{t("scheduler.nextTick")}</label>

        <DateTimePicker
          value={form.next_tick * 1000}
          onChange={(ts) => {
            if (ts !== null && Number.isFinite(ts))
              handleChange("next_tick", Math.floor(ts / 1000));
          }}
          className="w-full justify-center flex"
        />

        <div className="grid grid-cols-1 gap-y-2 lg:grid-cols-2 gap-2">
          {/* Priority */}
          <FormInput
            label={t("scheduler.priority")}
            type="number"
            value={form.priority ?? 0}
            onChange={(e) => handleChange("priority", Number(e.target.value))}
          />

          {/* Execution interval */}
          <FormInput
            label={t("scheduler.interval")}
            type="number"
            value={form.interval ?? 0}
            onChange={(e) => handleChange("interval", Number(e.target.value))}
            min={0}
          />

          {/* Daily reset */}
          <TimeSelectorModal
            label={t("scheduler.dailyReset")}
            values={form.daily_reset ?? []}
            onChange={(newTimes) => {
              handleChange("daily_reset", newTimes);
            }}
            mode="time"
          />

          {/* Disabled time range */}
          <TimeSelectorModal
            label={t("scheduler.disabledRange")}
            values={form.disabled_time_range ?? []}
            onChange={(newRanges) => {
              handleChange("disabled_time_range", newRanges);
            }}
            mode="range"
          />

          {/* Prerequisite task */}
          <OrderedMultiSelector
            label={t("scheduler.preTask")}
            values={form.pre_task ?? []}
            onChange={(newValues: any[]) => {
              setForm((d) => ({ ...d, pre_task: newValues }));
            }}
            alternatives={allTasks}
            translatePrefix="eventName"
          />

          {/* Post-task */}
          <OrderedMultiSelector
            label={t("scheduler.postTask")}
            values={form.post_task ?? []}
            onChange={(newValues: any[]) => {
              setForm((d) => ({ ...d, post_task: newValues }));
            }}
            alternatives={allTasks}
            translatePrefix="eventName"
          />
        </div>

        {/* Actions */}
        <div className="modal-footer">
          <CButton onClick={handleSave}>{t("common.confirm")}</CButton>
        </div>
      </div>
    </Modal>
  );
};

export default FeatureSwitchModal;

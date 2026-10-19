import React, { type Dispatch, type SetStateAction } from "react";
import {
  ConfigurationGroup,
  ConfigurationRow,
} from "@/components/configuration/ConfigurationControls";
import { useAppTranslation } from "@/shared/useAppTranslation";
import { toast } from "sonner";
import { getTimestampMs } from "@/shared/GlobalUtilities";
import type { PageKey } from "@/types/app";
import { useWebSocketStore } from "@/store/WebsocketStore";
import { eventNameKey } from "@/shared/I18nKeys";

interface OtherConfigProps {
  profileId: string;
  onClose: () => void;
  setActivePage?: Dispatch<SetStateAction<PageKey>>;
}
const OtherConfig: React.FC<OtherConfigProps> = ({ profileId, onClose, setActivePage }) => {
  const { t } = useAppTranslation();
  const trigger = useWebSocketStore((state) => state.trigger);
  const execute = () => {
    const task = "start_fhx";
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
  return (
    <ConfigurationGroup title={t("other")}>
      <ConfigurationRow
        label={t("other.fhx")}
        description={t("description.other.fhx")}
        className="configuration-row-action"
      >
        <button type="button" onClick={execute} className="configuration-action">
          {t("common.execute")}
        </button>
      </ConfigurationRow>
    </ConfigurationGroup>
  );
};
export default OtherConfig;

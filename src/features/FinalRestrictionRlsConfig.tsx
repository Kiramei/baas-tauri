import React, { useMemo } from "react";
import {
  ConfigurationGroup,
  ConfigurationInput,
  ConfigurationSelect,
} from "@/components/configuration/ConfigurationControls";
import { useAppTranslation } from "@/shared/useAppTranslation";
import { useWebSocketStore } from "@/store/WebsocketStore";
import { useConfigurationDraft } from "@/shared/useConfigurationDraft";
import {
  isCopyClearUnit,
  normalizeFinalRestrictionConfig,
  type FinalRestrictionFormationMethod,
} from "@/features/issue528Config";

interface FinalRestrictionRlsConfigProps {
  profileId: string;
  onClose: () => void;
}
interface Draft {
  formationMethod: FinalRestrictionFormationMethod;
  maxUnavailableStudentCount: string;
  maxRefreshCount: string;
}
const FinalRestrictionRlsConfig: React.FC<FinalRestrictionRlsConfigProps> = ({ profileId }) => {
  const { t } = useAppTranslation();
  const settings = useWebSocketStore((state) => state.configStore[profileId]);
  const initial = useMemo<Draft>(() => {
    const current = normalizeFinalRestrictionConfig(settings);
    return {
      ...current,
      maxUnavailableStudentCount: String(current.maxUnavailableStudentCount),
      maxRefreshCount: String(current.maxRefreshCount),
    };
  }, [settings]);
  const [draft, setDraft] = useConfigurationDraft(profileId, "finalRestrictionRls", initial, {
    serialize: (value) => {
      const unavailable = Number(value.maxUnavailableStudentCount);
      const refresh = Number(value.maxRefreshCount);
      if (
        !value.maxUnavailableStudentCount.trim() ||
        !Number.isInteger(unavailable) ||
        unavailable < 0 ||
        unavailable > 10 ||
        !value.maxRefreshCount.trim() ||
        !Number.isInteger(refresh) ||
        refresh < 0
      )
        return null;
      return {
        final_restriction_rls_employ_formation_method: value.formationMethod,
        final_restriction_rls_employ_formation_copy_clear_unit_max_unavailable_student_count:
          unavailable,
        final_restriction_rls_employ_formation_copy_clear_unit_max_refresh_count: refresh,
      };
    },
  });
  const copyClearEnabled = isCopyClearUnit(draft.formationMethod);
  return (
    <ConfigurationGroup title={t("finalRestrictionRls")}>
      <ConfigurationSelect
        label={t("finalRestrictionRls.formationMethod")}
        description={t("configurationHelp.finalMethod")}
        value={draft.formationMethod}
        onChange={(value) =>
          setDraft((previous) => ({
            ...previous,
            formationMethod: value as FinalRestrictionFormationMethod,
          }))
        }
        options={[
          { value: "default", label: t("finalRestrictionRls.useCurrentFormation") },
          { value: "copy_clear_unit", label: t("finalRestrictionRls.copyClearFormation") },
        ]}
      />
      <ConfigurationInput
        type="number"
        label={t("finalRestrictionRls.maxUnavailableStudentCount")}
        description={t("configurationHelp.finalUnavailable")}
        value={draft.maxUnavailableStudentCount}
        onChange={(event) =>
          setDraft((previous) => ({ ...previous, maxUnavailableStudentCount: event.target.value }))
        }
        min={0}
        max={10}
        disabled={!copyClearEnabled}
      />
      <ConfigurationInput
        type="number"
        label={t("finalRestrictionRls.maxRefreshCount")}
        description={t("configurationHelp.finalRefresh")}
        value={draft.maxRefreshCount}
        onChange={(event) =>
          setDraft((previous) => ({ ...previous, maxRefreshCount: event.target.value }))
        }
        min={0}
        disabled={!copyClearEnabled}
      />
      {!copyClearEnabled && (
        <p className="px-4 pb-4 text-xs leading-5 text-muted-foreground">
          {t("finalRestrictionRls.copyClearUnavailableHint")}
        </p>
      )}
    </ConfigurationGroup>
  );
};
export default FinalRestrictionRlsConfig;

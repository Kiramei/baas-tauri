import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FormInput } from "@/components/ui/FormInput";
import { FormSelect } from "@/components/ui/FormSelect";
import { useWebSocketStore } from "@/store/WebsocketStore";
import type { DynamicConfig } from "@/types/dynamic";
import {
  createFinalRestrictionPatch,
  isCopyClearUnit,
  normalizeFinalRestrictionConfig,
  parseBoundedInteger,
  type FinalRestrictionFormationMethod,
  withFormationMethod,
} from "@/features/issue528Config";

interface FinalRestrictionRlsConfigProps {
  profileId: string;
  onClose: () => void;
}

const FinalRestrictionRlsConfig: React.FC<FinalRestrictionRlsConfigProps> = ({
  profileId,
  onClose,
}) => {
  const { t } = useTranslation();
  const settings: Partial<DynamicConfig> = useWebSocketStore(
    (state) => state.configStore[profileId]
  );
  const modify = useWebSocketStore((state) => state.modify);
  const current = useMemo(() => normalizeFinalRestrictionConfig(settings), [settings]);
  const [draft, setDraft] = useState(current);
  const copyClearEnabled = isCopyClearUnit(draft.formationMethod);
  const dirty = JSON.stringify(draft) !== JSON.stringify(current);

  const handleMethodChange = (value: string) => {
    setDraft((previous) => withFormationMethod(previous, value as FinalRestrictionFormationMethod));
  };

  const handleNumberChange =
    (field: "maxUnavailableStudentCount" | "maxRefreshCount") =>
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const parsed =
        field === "maxUnavailableStudentCount"
          ? parseBoundedInteger(event.target.value, 0, 10)
          : parseBoundedInteger(event.target.value, 0);
      if (parsed !== null) setDraft((previous) => ({ ...previous, [field]: parsed }));
    };

  const handleSave = () => {
    const patch = createFinalRestrictionPatch(current, draft);
    if (Object.keys(patch).length > 0) modify(`${profileId}::config`, patch);
    onClose();
  };

  return (
    <div className="space-y-6">
      <FormSelect
        label={t("finalRestrictionRls.formationMethod")}
        ariaLabel={t("finalRestrictionRls.formationMethod")}
        value={draft.formationMethod}
        onChange={handleMethodChange}
        options={[
          { value: "default", label: t("finalRestrictionRls.useCurrentFormation") },
          { value: "copy_clear_unit", label: t("finalRestrictionRls.copyClearFormation") },
        ]}
      />

      <div className="space-y-3">
        <FormInput
          type="number"
          min={0}
          max={10}
          disabled={!copyClearEnabled}
          label={t("finalRestrictionRls.maxUnavailableStudentCount")}
          value={draft.maxUnavailableStudentCount}
          onChange={handleNumberChange("maxUnavailableStudentCount")}
        />
        <FormInput
          type="number"
          min={0}
          disabled={!copyClearEnabled}
          label={t("finalRestrictionRls.maxRefreshCount")}
          value={draft.maxRefreshCount}
          onChange={handleNumberChange("maxRefreshCount")}
        />
        {!copyClearEnabled && (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {t("finalRestrictionRls.copyClearUnavailableHint")}
          </p>
        )}
      </div>

      <div className="flex justify-end border-t border-slate-200 pt-4 dark:border-slate-700">
        <button
          type="button"
          onClick={handleSave}
          disabled={!dirty}
          className="rounded-lg bg-primary-600 px-6 py-2 font-semibold text-white hover:bg-primary-700 disabled:opacity-60"
        >
          {t("common.save")}
        </button>
      </div>
    </div>
  );
};

export default FinalRestrictionRlsConfig;

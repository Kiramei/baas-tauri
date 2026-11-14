import CButton from "@/components/ui/CButton";
import { SettingsRow } from "@/components/settings/SettingsControls";
import { reloadWithoutPrompt } from "@/shared/reload";
import { useAppTranslation } from "@/shared/useAppTranslation";

export function ReloadSettingsRow() {
  const { t } = useAppTranslation();
  return (
    <SettingsRow label={t("settings.ui.reloadInterface")}>
      <CButton
        type="button"
        variant="secondary"
        className="min-h-11 shrink-0"
        aria-label={t("settings.ui.reloadInterface")}
        onClick={reloadWithoutPrompt}
      >
        {t("contextMenu.reload")}
      </CButton>
    </SettingsRow>
  );
}

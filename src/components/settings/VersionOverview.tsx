import { Loader2, RefreshCw } from "lucide-react";
import CButton from "@/components/ui/CButton";
import { EllipsisWithTooltip } from "@/components/ui/ETooltip";
import { useAppTranslation } from "@/shared/useAppTranslation";
import { SettingsGroup } from "./SettingsControls";

interface VersionValues {
  current: string;
  latest: string;
  currentDetail?: string;
  latestDetail?: string;
}

interface VersionOverviewProps {
  script: VersionValues & {
    source: string;
    checking: boolean;
    checkLabel: string;
    onCheck: () => void | Promise<void>;
  };
  client?: VersionValues & {
    status: string;
    busy: boolean;
    updateAvailable: boolean;
    onAction: () => void | Promise<void>;
  };
}

function VersionFields({ current, latest, currentDetail, latestDetail }: VersionValues) {
  const { t } = useAppTranslation();
  return (
    <dl className="settings-version-fields">
      <div>
        <dt>{t("version.local")}</dt>
        <dd>
          <EllipsisWithTooltip text={current} tooltip={currentDetail} />
        </dd>
      </div>
      <div>
        <dt>{t("version.remote")}</dt>
        <dd>
          <EllipsisWithTooltip text={latest} tooltip={latestDetail} />
        </dd>
      </div>
    </dl>
  );
}

/** Keep each product's versions and update action together in reading order. */
export function VersionOverview({ script, client }: VersionOverviewProps) {
  const { t } = useAppTranslation();
  return (
    <>
      <SettingsGroup title={t("about.backendCommit")}>
        <VersionFields {...script} />
        <div className="settings-version-footer">
          <p className="settings-description">
            {t("update.method")}
            <span className="settings-version-source">{script.source}</span>
          </p>
          <CButton
            type="button"
            variant="secondary"
            className="settings-update-action"
            disabled={script.checking}
            onClick={script.onCheck}
          >
            {script.checking ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {script.checkLabel}
          </CButton>
        </div>
      </SettingsGroup>
      {client && (
        <SettingsGroup title={t("about.clientVersion")}>
          <VersionFields {...client} />
          <div className="settings-version-footer">
            <p className="settings-description" role="status">
              {client.status}
            </p>
            <CButton
              type="button"
              variant="secondary"
              className="settings-update-action"
              disabled={client.busy}
              onClick={client.onAction}
            >
              {client.busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {client.updateAvailable ? t("update.tauriInstallTitle") : t("version.tapToTest")}
            </CButton>
          </div>
        </SettingsGroup>
      )}
    </>
  );
}

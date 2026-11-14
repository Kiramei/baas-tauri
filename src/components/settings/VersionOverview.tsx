import { Loader2, RefreshCw } from "lucide-react";
import CButton from "@/components/ui/CButton";
import { EllipsisWithTooltip } from "@/components/ui/ETooltip";
import { useAppTranslation } from "@/shared/useAppTranslation";
import { useTauriSelfUpdate } from "@/context/TauriSelfUpdateProvider";
import { resolveClientVersion } from "@/shared/ClientVersion";
import { useWebSocketStore } from "@/store/WebsocketStore";
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

function ClientVersionOverview() {
  const { t } = useAppTranslation();
  const { updating, runUpdate } = useTauriSelfUpdate();
  const report = useWebSocketStore((state) => state.versionStore.tauri) ?? {};
  const checkTauriUpdater = useWebSocketStore((state) => state.checkTauriUpdater);
  const current = resolveClientVersion(report.currentVersion);
  const latest = report.error
    ? t("version.checkError")
    : report.lastChecked
      ? resolveClientVersion(report.version, current)
      : "—";
  const busy = Boolean(report.checking || updating);
  let status = "";
  if (report.checking) status = t("update.tauriChecking");
  else if (report.error) status = t("update.tauriFailed");
  else if (report.disabled) status = t("update.tauriDisabled");
  else if (report.missingPackage) status = t("update.androidPackageUnavailable");
  else if (report.updateAvailable) status = t("update.tauriAvailable");
  else if (report.lastChecked) status = t("update.tauriUpToDate");

  return (
    <SettingsGroup title={t("about.clientVersion")}>
      <VersionFields current={current} latest={latest} />
      <div className="settings-version-footer">
        <p className="settings-description" role="status">
          {status}
        </p>
        <CButton
          type="button"
          variant="secondary"
          className="settings-update-action"
          disabled={busy}
          onClick={report.updateAvailable ? runUpdate : () => void checkTauriUpdater(true, true)}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {report.updateAvailable ? t("update.tauriInstallTitle") : t("version.tapToTest")}
        </CButton>
      </div>
    </SettingsGroup>
  );
}

/** Keep each product's versions and update action together in reading order. */
export function VersionOverview({ script }: VersionOverviewProps) {
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
      {__WITH_TAURI__ && <ClientVersionOverview />}
    </>
  );
}

import { useId, type ReactNode } from "react";
import { ChevronRight, Settings2 } from "lucide-react";
import CButton from "@/components/ui/CButton";
import { useAppTranslation } from "@/shared/useAppTranslation";
import "./install-preflight.css";

interface InstallPreflightProps {
  children: ReactNode;
  channelLabel: string;
  transportLabel: string;
  onAdvanced: () => void;
  onCancel: () => void;
  onStart: () => void;
}

/** Keeps installation choices and their actions in one compact, responsive panel. */
const InstallPreflight = ({
  children,
  channelLabel,
  transportLabel,
  onAdvanced,
  onCancel,
  onStart,
}: InstallPreflightProps) => {
  const { t } = useAppTranslation();
  const titleId = useId();

  return (
    <section
      className="install-preflight"
      data-installer-phase="settings"
      aria-labelledby={titleId}
    >
      <div className="install-preflight-main">
        <h2 className="install-preflight-title" id={titleId}>
          {t("installer.setting")}
        </h2>
        <div className="install-preflight-directory">{children}</div>
        <div className="install-preflight-options">
          <dl className="install-preflight-summary">
            <div className="install-preflight-summary-item">
              <dt>{t("update.channel")}</dt>
              <dd>{channelLabel}</dd>
            </div>
            <div className="install-preflight-summary-item">
              <dt>{t("transport.label")}</dt>
              <dd>{transportLabel}</dd>
            </div>
          </dl>
          <button type="button" className="install-preflight-advanced" onClick={onAdvanced}>
            <Settings2 className="size-4 shrink-0" strokeWidth={1.5} />
            <span className="install-preflight-advanced-label">{t("installer.advanced")}</span>
            <span className="install-preflight-advanced-hint">{t("installer.advancedHint")}</span>
            <ChevronRight className="size-4 shrink-0" strokeWidth={1.5} />
          </button>
        </div>
      </div>
      <footer className="install-preflight-actions">
        <CButton variant="secondary" onClick={onCancel}>
          {t("installer.exit")}
        </CButton>
        <CButton variant="primary" onClick={onStart}>
          {t("installer.start")}
        </CButton>
      </footer>
    </section>
  );
};

export default InstallPreflight;

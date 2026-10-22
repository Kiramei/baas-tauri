import { invoke } from "@/shared/TauriInvoke";
import { motion } from "framer-motion";
import { X } from "lucide-react";
import { toast } from "sonner";
import { useAppTranslation } from "@/shared/useAppTranslation";
import { loadLocale } from "@/shared/I18nTranslator";
import type { Theme } from "@/types/app";
import { useTheme } from "@/context/ThemeProvider";
import { FormSelect } from "@/components/ui/FormSelect.tsx";
import { FormInput } from "@/components/ui/FormInput.tsx";
import SwitchButton from "@/components/ui/SwitchButton.tsx";
import CButton from "@/components/ui/CButton.tsx";
import LanguageSelect from "@/components/LanguageSelect.tsx";
import { ThemeSelector } from "@/components/ui/ThemeSelector";
import { useEffect, useId, useRef, useState } from "react";
import { useModalFocus } from "@/components/ui/Modal";
import { createPortal } from "react-dom";
import { useSetUISettings, useUISetting } from "@/context/UISettingsProvider.tsx";
import { isMacOS, normalizeTransportMode, supportsSharedMemory } from "@/transport/factory";

type Channel = "stable" | "dev";
type Transport = "websocket" | "pipe" | "shm";

interface MirrorCValidateReport {
  success: boolean;
  code?: number | null;
  message: string;
  mirrorcMessage?: string | null;
  latestVersion?: string | null;
  expiresAt?: number | null;
  expiresAtIso?: string | null;
}

interface MirrorCStatus {
  tone: "success" | "error" | "info";
  title: string;
  detail: string;
}

interface UpdaterConfig {
  general?: {
    channel?: Channel;
    mirrorc_cdk?: string;
    mirrorcCdk?: string;
    no_update?: boolean;
    noUpdate?: boolean;
    transport?: Transport;
  };
}

interface ConfigEditorProps {
  config: UpdaterConfig;
  setConfig: (config: UpdaterConfig) => void;
  open: boolean;
  disabled?: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}

const overlayCls = "fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-[1100]";

const setupMirrorcCdk = (config: UpdaterConfig | null | undefined) =>
  config?.general?.mirrorc_cdk || config?.general?.mirrorcCdk || "";

const setupNoUpdate = (config: UpdaterConfig | null | undefined) =>
  Boolean(config?.general?.no_update ?? config?.general?.noUpdate ?? false);

/** Renders the config editor modal component. */
const ConfigEditorModal = (props: ConfigEditorProps) => {
  const { t } = useAppTranslation();
  const { theme, setTheme } = useTheme();
  const lowPerformanceMode = useUISetting((settings) => settings.lowPerformanceMode);
  const autoEnterAfterInstall = useUISetting(
    (settings) => settings.autoEnterAfterInstall !== false
  );
  const setUISettings = useSetUISettings();
  const [cdkInput, setCdkInput] = useState(setupMirrorcCdk(props.config));
  const [validating, setValidating] = useState(false);
  const [cdkStatus, setCdkStatus] = useState<MirrorCStatus | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const autoEnterHintId = useId();
  useModalFocus(props.open, panelRef, props.onCancel);

  useEffect(() => {
    if (props.open) {
      setCdkInput(setupMirrorcCdk(props.config));
      setCdkStatus(null);
    }
  }, [props.open, props.config]);

  if (!props.open) return null;

  const channel = props.config?.general?.channel ?? "stable";
  const noUpdate = setupNoUpdate(props.config);
  const transport = normalizeTransportMode(props.config?.general?.transport);

  const patchGeneral = (patch: Partial<NonNullable<UpdaterConfig["general"]>>) => {
    props.setConfig({
      ...props.config,
      general: {
        ...props.config.general,
        ...patch,
      },
    });
  };

  /** Handles the handle language change interaction. */
  const handleLanguageChange = (value: string) => {
    loadLocale(value).then(() => {
      setUISettings((settings) => ({ ...settings, lang: value }));
    });
  };

  /** Handles the handle theme change interaction. */
  const handleThemeChange = (newTheme: Theme) => {
    setTheme(newTheme);
    setUISettings((settings) => ({ ...settings, theme: newTheme }));
  };

  const describeMirrorCReport = (report: MirrorCValidateReport) => {
    const parts = [report.message];
    if (report.expiresAtIso) parts.push(`Expires at: ${report.expiresAtIso}`);
    if (report.latestVersion) parts.push(`Latest version: ${report.latestVersion}`);
    if (!report.success && report.code != null) parts.push(`Code: ${report.code}`);
    if (!report.success && report.mirrorcMessage && report.mirrorcMessage !== report.message) {
      parts.push(`MirrorC: ${report.mirrorcMessage}`);
    }
    return parts.join("\n");
  };

  const validateMirrorC = async () => {
    setValidating(true);
    setCdkStatus({
      tone: "info",
      title: "Validating MirrorC CDK",
      detail: "Waiting for MirrorC response...",
    });
    try {
      const report = await invoke<MirrorCValidateReport>("updater_validate_mirrorc_cdk", {
        request: {
          cdk: cdkInput,
          channel,
        },
      });
      const detail = describeMirrorCReport(report);
      if (report.success) {
        patchGeneral({ mirrorc_cdk: cdkInput.trim() });
        setCdkStatus({
          tone: "success",
          title: "MirrorC CDK valid",
          detail,
        });
        toast.success("MirrorC CDK valid", {
          description: detail,
        });
      } else {
        setCdkInput("");
        patchGeneral({ mirrorc_cdk: "" });
        setCdkStatus({
          tone: "error",
          title: "MirrorC CDK invalid",
          detail,
        });
        toast.error("MirrorC CDK invalid", {
          description: detail,
        });
      }
    } catch (error) {
      setCdkInput("");
      patchGeneral({ mirrorc_cdk: "" });
      const detail = error instanceof Error ? error.message : String(error);
      setCdkStatus({
        tone: "error",
        title: "MirrorC CDK validation failed",
        detail,
      });
      toast.error("MirrorC CDK validation failed", {
        description: detail,
      });
    } finally {
      setValidating(false);
    }
  };

  return createPortal(
    <div
      data-modal-backdrop=""
      className={overlayCls}
      style={{ paddingTop: "calc(var(--window-titlebar-height, 0px) + 1rem)" }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onCancel();
      }}
    >
      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        initial={lowPerformanceMode ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={lowPerformanceMode ? undefined : { opacity: 0, y: 8 }}
        transition={{ duration: lowPerformanceMode ? 0 : 0.16 }}
        className="modal-surface flex w-full max-w-2xl flex-col overflow-hidden"
        style={{ maxHeight: "calc(100dvh - var(--window-titlebar-height, 0px) - 2rem)" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-header shrink-0">
          <h3 id={titleId} className="modal-title">
            {t("installer.advanced")}
          </h3>
          <button
            type="button"
            onClick={props.onCancel}
            aria-label={t("common.close")}
            className="modal-close"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-col gap-5 overflow-y-auto overscroll-contain">
          <LanguageSelect handleLanguageChange={handleLanguageChange} />
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">
              {t("common.theme")}
            </label>
            <ThemeSelector value={theme} onChange={handleThemeChange} fullWidth />
          </div>
          <div className="grid grid-cols-1 gap-4 border-t border-border/70 pt-5 sm:grid-cols-2">
            <FormSelect
              label={t("update.channel")}
              value={channel}
              onChange={(value) => patchGeneral({ channel: value as Channel })}
              options={[
                { value: "stable", label: t("updateChannel.stable") },
                { value: "dev", label: t("updateChannel.dev") },
              ]}
            />
            <FormSelect
              label={t("transport.label")}
              value={transport}
              onChange={(value) => patchGeneral({ transport: value as Transport })}
              options={[
                { value: "websocket", label: t("transport.websocket") },
                ...(!isMacOS ? [{ value: "pipe", label: t("transport.pipe") }] : []),
                ...(supportsSharedMemory() ? [{ value: "shm", label: t("transport.shm") }] : []),
              ]}
            />
          </div>
          <SwitchButton
            label={t("update.skip")}
            checked={noUpdate}
            onChange={(checked) => patchGeneral({ no_update: checked })}
            disabled={props.disabled}
          />
          <div>
            <SwitchButton
              label={t("installer.autoEnter")}
              checked={autoEnterAfterInstall}
              onChange={(checked) =>
                setUISettings((settings) => ({ ...settings, autoEnterAfterInstall: checked }))
              }
              aria-describedby={autoEnterHintId}
              className="w-full"
              disabled={props.disabled}
            />
            <p id={autoEnterHintId} className="mt-2 px-1 text-xs leading-5 text-muted-foreground">
              {t("installer.autoEnterHint")}
            </p>
          </div>
          <div className="flex gap-2 items-end border-t border-border/70 pt-5">
            <FormInput
              label={t("update.mirrorCdk")}
              value={cdkInput}
              onChange={(event) => {
                setCdkInput(event.target.value);
                setCdkStatus(null);
              }}
              placeholder={t("update.enterCdk")}
              className="flex-1"
              disabled={validating}
            />
            <CButton
              type="button"
              variant="secondary"
              disabled={validating}
              onClick={validateMirrorC}
              className="min-w-24"
            >
              {validating ? t("mirror.verifying") : t("mirror.verify")}
            </CButton>
          </div>
          {cdkStatus && (
            <div
              className={`rounded-md border px-3 py-2 text-sm whitespace-pre-wrap ${
                cdkStatus.tone === "success"
                  ? "border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-300"
                  : cdkStatus.tone === "error"
                    ? "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300"
                    : "border-border bg-secondary/50 text-foreground"
              }`}
            >
              <div className="font-medium">{cdkStatus.title}</div>
              <div className="mt-1">{cdkStatus.detail}</div>
            </div>
          )}
        </div>

        <div className="modal-footer shrink-0">
          <CButton
            type="button"
            variant="secondary"
            className="border-transparent bg-secondary hover:bg-accent"
            onClick={props.onCancel}
          >
            {t("common.cancel")}
          </CButton>
          <CButton type="button" onClick={props.onConfirm} disabled={props.disabled}>
            {t("common.confirm")}
          </CButton>
        </div>
      </motion.div>
    </div>,
    document.body
  );
};

export default ConfigEditorModal;

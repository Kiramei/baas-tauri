import { invoke } from "@/shared/TauriInvoke";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { loadLocale } from "@/shared/I18nTranslator";
import { themeKey } from "@/shared/I18nKeys";
import StorageUtil from "@/shared/StorageManager";
import type { Theme } from "@/types/app";
import { useTheme } from "@/context/ThemeProvider";
import { FormSelect } from "@/components/ui/FormSelect.tsx";
import { FormInput } from "@/components/ui/FormInput.tsx";
import SwitchButton from "@/components/ui/SwitchButton.tsx";
import CButton from "@/components/ui/CButton.tsx";
import LanguageSelect from "@/components/LanguageSelect.tsx";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useUISetting } from "@/context/UISettingsProvider.tsx";
import { normalizeTransportMode, supportsSharedMemory } from "@/transport/factory";

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
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  const lowPerformanceMode = useUISetting((settings) => settings.lowPerformanceMode);
  const [cdkInput, setCdkInput] = useState(setupMirrorcCdk(props.config));
  const [validating, setValidating] = useState(false);
  const [cdkStatus, setCdkStatus] = useState<MirrorCStatus | null>(null);

  useEffect(() => {
    if (props.open) {
      setCdkInput(setupMirrorcCdk(props.config));
      setCdkStatus(null);
    }
  }, [props.open, props.config]);

  if (!props.open) return null;

  const channel = props.config?.general?.channel ?? "stable";
  const noUpdate = setupNoUpdate(props.config);
  const transport = props.config?.general?.transport ?? normalizeTransportMode(undefined);

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
      const uiSettings = StorageUtil.get("uiSettings")!;
      uiSettings["lang"] = value;
      StorageUtil.set("uiSettings", uiSettings);
    });
  };

  /** Handles the handle theme change interaction. */
  const handleThemeChange = (newTheme: Theme) => {
    setTheme(newTheme);
    const uiSettings = StorageUtil.get("uiSettings")!;
    uiSettings["theme"] = newTheme;
    StorageUtil.set("uiSettings", uiSettings);
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
      className={overlayCls}
      style={{ paddingTop: "calc(var(--window-titlebar-height, 0px) + 1rem)" }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onCancel();
      }}
    >
      <motion.div
        initial={lowPerformanceMode ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={lowPerformanceMode ? undefined : { opacity: 0, y: 8 }}
        transition={{ duration: lowPerformanceMode ? 0 : 0.16 }}
        className="w-full max-w-2xl overflow-y-auto overscroll-contain rounded-2xl border border-border bg-popover p-5 text-popover-foreground shadow-[var(--popover-shadow)]"
        style={{ maxHeight: "calc(100dvh - var(--window-titlebar-height, 0px) - 2rem)" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3 className="font-medium text-lg">{t("installer.setting")}</h3>

        <div className="flex flex-col gap-3 mt-4">
          <LanguageSelect handleLanguageChange={handleLanguageChange} />
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">
              {t("common.theme")}
            </label>
            <div className="flex gap-1 rounded-lg bg-secondary p-1">
              {(["light", "dark", "system"] as Theme[]).map((value) => (
                <button
                  key={value}
                  onClick={() => handleThemeChange(value)}
                  className={`flex-1 py-2 text-sm font-medium rounded-md transition-colors ${
                    theme === value
                      ? "bg-card text-foreground shadow-xs"
                      : "text-muted-foreground hover:bg-card/60"
                  }`}
                >
                  {t(themeKey(value))}
                </button>
              ))}
            </div>
          </div>
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
              { value: "pipe", label: t("transport.pipe") },
              ...(supportsSharedMemory() ? [{ value: "shm", label: t("transport.shm") }] : []),
            ]}
          />
          <SwitchButton
            label={t("update.skip")}
            checked={noUpdate}
            onChange={(checked) => patchGeneral({ no_update: checked })}
            disabled={props.disabled}
          />
          <div className="flex gap-2 items-end">
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

        <div className="mt-5 flex justify-end gap-2">
          <CButton type="button" variant="secondary" onClick={props.onCancel}>
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

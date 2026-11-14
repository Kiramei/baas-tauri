import { MirrorCdkField } from "@/components/settings/MirrorCdkField";
import { motion } from "framer-motion";
import { X } from "lucide-react";
import { toast } from "sonner";
import { useAppTranslation } from "@/shared/useAppTranslation";
import { loadLocale } from "@/shared/I18nTranslator";
import type { Theme } from "@/types/app";
import { useTheme } from "@/context/ThemeProvider";
import { FormSelect } from "@/components/ui/FormSelect.tsx";
import SwitchButton from "@/components/ui/SwitchButton.tsx";
import CButton from "@/components/ui/CButton.tsx";
import LanguageSelect from "@/components/LanguageSelect.tsx";
import { ThemeSelector } from "@/components/ui/ThemeSelector";
import { useId, useRef, useState } from "react";
import { useModalFocus } from "@/components/ui/Modal";
import { createPortal } from "react-dom";
import { useSetUISettings, useUISetting } from "@/context/UISettingsProvider.tsx";
import { isMacOS, normalizeTransportMode, supportsSharedMemory } from "@/transport/factory";

type Channel = "stable" | "dev";
type Transport = "websocket" | "pipe" | "shm";

interface UpdaterConfig {
  general?: {
    channel?: Channel;
    mirrorc_cdk_configured?: boolean;
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
  onConfirm: (cdk?: string) => void | Promise<void>;
}

const overlayCls = "fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-[1100]";

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
  const [pendingCdk, setPendingCdk] = useState<string>();
  const [validating, setValidating] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const autoEnterHintId = useId();
  useModalFocus(props.open, panelRef, props.onCancel);

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
    void loadLocale(value).then((loaded) => {
      if (loaded) setUISettings((settings) => ({ ...settings, lang: value }));
    });
  };

  /** Handles the handle theme change interaction. */
  const handleThemeChange = (newTheme: Theme) => {
    setTheme(newTheme);
    setUISettings((settings) => ({ ...settings, theme: newTheme }));
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
              onChange={(value) => {
                patchGeneral({ channel: value as Channel });
              }}
              disabled={validating}
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
          {channel === "stable" && (
            <MirrorCdkField
              key={channel}
              label={t("update.mirrorCdk")}
              channel={channel}
              configured={
                pendingCdk === undefined
                  ? !!props.config.general?.mirrorc_cdk_configured
                  : !!pendingCdk
              }
              pendingKey={pendingCdk}
              disabled={props.disabled}
              onChange={setPendingCdk}
              onBusy={setValidating}
            />
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
          <CButton
            type="button"
            onClick={() =>
              void Promise.resolve(props.onConfirm(pendingCdk)).catch(() =>
                toast.error(t("mirrorc.cdk.requestFailed"))
              )
            }
            disabled={props.disabled || validating}
          >
            {t("common.confirm")}
          </CButton>
        </div>
      </motion.div>
    </div>,
    document.body
  );
};

export default ConfigEditorModal;

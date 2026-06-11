import { invoke } from "@tauri-apps/api/core";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { loadLocale } from "@/shared/I18nTranslator";
import StorageUtil from "@/shared/StorageManager";
import type { Theme } from "@/types/app";
import { useTheme } from "@/context/ThemeProvider";
import { FormSelect } from "@/components/ui/FormSelect.tsx";
import { FormInput } from "@/components/ui/FormInput.tsx";
import CButton from "@/components/ui/CButton.tsx";
import { useEffect, useState } from "react";

type Channel = "stable" | "dev";

interface UpdaterConfig {
  general?: {
    channel?: Channel;
    mirrorcCdk?: string;
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

const overlayCls =
  "fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50";

const ConfigEditorModal = (props: ConfigEditorProps) => {
  const { t, i18n } = useTranslation();
  const { theme, setTheme } = useTheme();
  const [cdkInput, setCdkInput] = useState(props.config?.general?.mirrorcCdk ?? "");
  const [validating, setValidating] = useState(false);

  useEffect(() => {
    if (props.open) {
      setCdkInput(props.config?.general?.mirrorcCdk ?? "");
    }
  }, [props.open, props.config?.general?.mirrorcCdk]);

  if (!props.open) return null;

  const channel = props.config?.general?.channel ?? "stable";

  const patchGeneral = (patch: Partial<NonNullable<UpdaterConfig["general"]>>) => {
    props.setConfig({
      ...props.config,
      general: {
        ...props.config.general,
        ...patch,
      },
    });
  };

  const handleLanguageChange = (value: string) => {
    loadLocale(value).then(() => {
      const uiSettings = StorageUtil.get("uiSettings")!;
      uiSettings["lang"] = value;
      StorageUtil.set("uiSettings", uiSettings);
    });
  };

  const handleThemeChange = (newTheme: Theme) => {
    setTheme(newTheme);
    const uiSettings = StorageUtil.get("uiSettings")!;
    uiSettings["theme"] = newTheme;
    StorageUtil.set("uiSettings", uiSettings);
  };

  const validateMirrorC = async () => {
    setValidating(true);
    try {
      const report = await invoke<{
        success: boolean;
        message: string;
        latestVersion?: string | null;
      }>("updater_validate_mirrorc_cdk", {
        request: {
          cdk: cdkInput,
          channel,
        },
      });
      if (report.success) {
        patchGeneral({ mirrorcCdk: cdkInput.trim() });
        toast.success("MirrorC CDK valid", {
          description: report.latestVersion
            ? `${report.message} Latest: ${report.latestVersion}`
            : report.message,
        });
      } else {
        setCdkInput("");
        patchGeneral({ mirrorcCdk: "" });
        toast.error("MirrorC CDK invalid", {
          description: report.message,
        });
      }
    } catch (error) {
      setCdkInput("");
      patchGeneral({ mirrorcCdk: "" });
      toast.error("MirrorC CDK validation failed", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setValidating(false);
    }
  };

  return (
    <div
      className={overlayCls}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onCancel();
      }}
    >
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 8 }}
        transition={{ duration: 0.16 }}
        className="w-full mx-2 md:mx-20 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-xl p-5"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3 className="font-semibold text-lg">{t("installer.setting")}</h3>

        <div className="flex flex-col gap-3 mt-4">
          <FormSelect
            value={i18n.language}
            label={t("language")}
            onChange={handleLanguageChange}
            options={[
              { value: "en", label: t("english") },
              { value: "zh", label: t("chinese") },
              { value: "ja", label: t("japanese") },
              { value: "ko", label: t("korean") },
              { value: "de", label: t("deutsch") },
              { value: "ru", label: t("russian") },
              { value: "fr", label: t("french") },
            ]}
          />
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-200 mb-2">
              {t("theme")}
            </label>
            <div className="flex space-x-2 p-1 bg-slate-100 dark:bg-slate-700 rounded-lg">
              {(["light", "dark", "system"] as Theme[]).map((value) => (
                <button
                  key={value}
                  onClick={() => handleThemeChange(value)}
                  className={`flex-1 py-2 text-sm font-medium rounded-md transition-colors ${
                    theme === value
                      ? "bg-white dark:bg-slate-600 shadow"
                      : "hover:bg-white/50 dark:hover:bg-slate-700/50"
                  }`}
                >
                  {t(value)}
                </button>
              ))}
            </div>
          </div>
          <FormSelect
            label="Channel"
            value={channel}
            onChange={(value) => patchGeneral({ channel: value as Channel })}
            options={[
              { value: "stable", label: "stable" },
              { value: "dev", label: "dev" },
            ]}
          />
          <div className="flex gap-2 items-end">
            <FormInput
              label="MirrorC CDK"
              value={cdkInput}
              onChange={(event) => setCdkInput(event.target.value)}
              placeholder="Paste MirrorC CDK"
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
              {validating ? "..." : "Validate"}
            </CButton>
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <CButton type="button" variant="secondary" onClick={props.onCancel}>
            {t("Cancel")}
          </CButton>
          <CButton type="button" onClick={props.onConfirm} disabled={props.disabled}>
            {t("Confirm")}
          </CButton>
        </div>
      </motion.div>
    </div>
  );
};

export default ConfigEditorModal;

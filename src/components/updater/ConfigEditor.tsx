import { FormSelect } from "@/components/ui/FormSelect.tsx";
import { useTranslation } from "react-i18next";
import { motion } from "framer-motion";
import { loadLocale } from "@/shared/I18nTranslator";
import StorageUtil from "@/shared/StorageManager";
import type { Theme } from "@/types/app";
import { useTheme } from "@/context/ThemeProvider";

// Define types matching Rust structs
interface SetupConfig {
  General: {
    source_list: string[];
    package_manager: string;
    debug: boolean;
    // ... other fields
  };
  URLs: {
    REPO_URL_HTTP: string;
    // ... other fields
  };
  // ... Paths
}

interface ConfigEditorProps {
  config: SetupConfig;
  setConfig: (config: SetupConfig) => void;
  open: boolean;
  disabled?: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}

const updateChannels = [
  {
    label: "https://github.com/pur1fying/blue_archive_auto_script.git",
    value: "https://github.com/pur1fying/blue_archive_auto_script.git",
  },
  {
    label: "https://gitee.com/pur1fy/blue_archive_auto_script.git",
    value: "https://gitee.com/pur1fy/blue_archive_auto_script.git",
  },
  {
    label: "https://gitcode.com/m0_74686738/blue_archive_auto_script.git",
    value: "https://gitcode.com/m0_74686738/blue_archive_auto_script.git",
  },
  {
    label: "https://github.com/Kiramei/baas-dev.git (Unstable)",
    value: "https://github.com/Kiramei/baas-dev.git",
  },
  {
    label: "https://gitee.com/kiramei/baas-dev.git (Unstable)",
    value: "https://gitee.com/kiramei/baas-dev.git",
  },
];

const overlayCls =
  "fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50";

const ConfigEditorModal = (props: ConfigEditorProps) => {
  const { t, i18n } = useTranslation();
  const handleLanguageChange = (value: string) => {
    loadLocale(value).then(() => {
      const uiSettings = StorageUtil.get("uiSettings")!;
      uiSettings["lang"] = value;
      StorageUtil.set("uiSettings", uiSettings);
    });
  };

  const { theme, setTheme } = useTheme();
  const handleThemeChange = (newTheme: Theme) => {
    setTheme(newTheme);
    const uiSettings = StorageUtil.get("uiSettings")!;
    uiSettings["theme"] = newTheme;
    StorageUtil.set("uiSettings", uiSettings);
  };

  if (!props.open) return null;

  const handleUrlChange = (key: string, value: string) => {
    props.setConfig({
      ...props.config,
      URLs: {
        ...props.config.URLs,
        [key]: value,
      },
    });
  };

  const handleGeneralChange = (key: string, value: any) => {
    props.setConfig({
      ...props.config,
      General: {
        ...props.config.General,
        [key]: value,
      },
    });
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

        <div className="flex flex-col gap-2 mt-4">
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
            label={t("label.repo_url")}
            value={props.config.URLs?.REPO_URL_HTTP || ""}
            onChange={(e) => handleUrlChange("REPO_URL_HTTP", e)}
            options={updateChannels}
          />
          <FormSelect
            label={t("label.pypi_mirror")}
            className={"col-span-3"}
            value={props.config.General?.source_list?.[0] || ""}
            onChange={(val: string) => {
              const newSources = [
                val,
                ...(props.config.General?.source_list?.filter((s: string) => s !== val) || []),
              ];
              handleGeneralChange("source_list", newSources);
            }}
            options={props.config.General!.source_list!.map((e: string) => ({
              label: e,
              value: e,
            }))}
          />
        </div>
      </motion.div>
    </div>
  );
};

export default ConfigEditorModal;

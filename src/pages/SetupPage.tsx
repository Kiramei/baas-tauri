import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import StorageUtil from "@/shared/StorageManager";
import { BaseBackendInterface } from "@/types/app";
import { listen } from "@tauri-apps/api/event";
import { useGlobalLogStore } from "@/store/GlobalLogStore.ts";
import { useWebSocketStore } from "@/store/WebsocketStore.ts";
import { formatIsoToReadableTime } from "@/shared/GlobalUtilities";
import { useTheme } from "@/context/ThemeProvider";
import CButton from "@/components/ui/CButton.tsx";
import ConfigEditorModal from "@/components/updater/ConfigEditor.tsx";
import { exit } from "@tauri-apps/plugin-process";
import { useTranslation } from "react-i18next";

import TermViewer from "@/components/updater/TermViewer.tsx";
import ProgressBar from "@/components/updater/ProgressBar";
import PathSelector from "@/components/updater/PathSelector";
import InstallerLayout from "@/components/updater/InstallerLayout";

const init = useWebSocketStore.getState().init;
void init();

const LEVEL_MAP = {
  "INFO": "info",
  "WARNING": "warning",
  "ERROR": "error",
  "CRITICAL": "critical",
};

const SetupPage = () => {
  const [started, setStarted] = useState(false);
  const [settingModal, setSettingModal] = useState(false);
  const [config, setConfig] = useState<any>(null);
  const [installPath, setInstallPath] = useState("");
  const [setupPhase, setSetupPhase] = useState(true);
  const appendTerminalLog = useGlobalLogStore((e) => e.appendTerminalLog);
  const setProgress = useGlobalLogStore((e) => e.setProgress);
  const { t } = useTranslation();

  useEffect(() => {
    const unlisten = listen<{ message: string; level: string }>("installer://log", (event) => {
      // Extract the message and level from the event
      let message = event.payload.message.replace(/^\S+\s+\S+\s+\[(INFO|WARN|ERRO|CRIT)]\s*/, "");
      let level = event.payload.level;

      // Try to parse the message in the format {flag} | {date} | {content}
      const parts = message.split(" | ");

      if (parts.length === 3) {
        // If it's in the format {flag} | {date} | {content}, parse it
        const flag = parts[0]; // {flag}
        const content = parts[2]; // {content}

        // Override level based on the flag
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-expect-error
        level = LEVEL_MAP[flag] || level; // Default to current level if no mapping found
        message = content.replace(/^\S+\s+\S+\s+\[(INFO|WARN|ERRO|CRIT)]\s*/, ""); // Set the message to the content part
      }

      appendTerminalLog({
        message,
        level: level as any, // Cast to correct type
        time: formatIsoToReadableTime(new Date().toISOString()),
      });
    });

    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<{ percentage: number; message: string }>(
      "installer://progress",
      (event) => {
        setProgress({
          progress: event.payload.percentage,
          message: event.payload.message,
        });
      }
    );

    return () => {
      unlisten.then((f) => f());
    };
  }, []);
  const setupCompletedRef = useRef(false);

  const startInstall = async (base_dir: string | null = null, base_config: any | null = null) => {
    setSetupPhase(false);
    setStarted(true);
    try {
      const ret: BaseBackendInterface = await invoke("start_installer", {
        "installPath": base_dir || installPath,
        "setupConfig": base_config || config,
      });
      StorageUtil.set("base_dir", base_dir || installPath);
      console.log(ret);
      StorageUtil.set("baseBackendAddr", ret.baseBackendAddr);
      StorageUtil.set("baseBackendPort", ret.baseBackendPort);
      StorageUtil.set("SECRET", ret.serviceSecret);
      useWebSocketStore.setState((state) => ({ ...state, _secret: ret.serviceSecret }));
    } catch (error) {
      StorageUtil.set("base_dir", null);
      console.error(error);
      setStarted(false);
      setSetupPhase(true); // Go back to set up on failure
    }
  };
  useEffect(() => {
    if (setupCompletedRef.current) return;

    (async () => {
      // Fetch defaults
      const p = await invoke("get_default_path");
      setInstallPath(p as string);
      const c = await invoke("get_default_config");
      setConfig(c);

      if (setupPhase && StorageUtil.get("base_dir")) {
        setSetupPhase(false);
        await startInstall(StorageUtil.get("base_dir"), c);
      }
    })();

    setupCompletedRef.current = true;
  }, []);

  const { theme } = useTheme();

  return (
    <>
      <div className="fixed inset-0 bg-slate-100 dark:bg-slate-950 overflow-hidden z-1">
        <img
          src={theme === "light" ? "/images/bg-light.webp" : "/images/bg-dark.webp"}
          alt="Loading BG"
          className="w-full h-full object-cover object-center"
        />
      </div>
      <InstallerLayout title={t("installer.title.wizard")}>
        <div className="flex flex-col gap-2 max-w-3xl mx-auto w-full bg-background px-5 md:px-20 py-5 backdrop-blur supports-backdrop-filter:bg-background/85 md:py-10 rounded-xl shadow-2xl shadow-slate-800">
          <div className="text-center space-y-2">
            <h2 className="text-2xl font-bold">{t("installer.title")}</h2>
            <p className="text-muted-foreground">
              {setupPhase ? t("installer.subtitle.stage_1") : t("installer.subtitle.stage_2")}
            </p>
          </div>

          <div className="space-y-1">
            {setupPhase && config && (
              <div className="space-y-1 animate-in fade-in slide-in-from-bottom-4 duration-500">
                <PathSelector path={installPath} setPath={setInstallPath} />
                <div className="flex justify-around pt-4 gap-2 flex-col md:flex-row max-md:w-full">
                  <CButton onClick={async () => await exit(0)} className="md:w-48" variant="danger">
                    {t("installer.exit")}
                  </CButton>
                  <CButton
                    onClick={() => setSettingModal(true)}
                    className="md:w-48"
                    variant="secondary"
                  >
                    {t("installer.advanced")}
                  </CButton>
                  <CButton onClick={() => startInstall()} className="md:w-48" variant="primary">
                    {t("installer.start")}
                  </CButton>
                </div>
              </div>
            )}

            {!setupPhase && started && (
              <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
                <ProgressBar />
                <TermViewer />
              </div>
            )}
          </div>
        </div>
        <ConfigEditorModal
          config={config}
          setConfig={setConfig}
          open={settingModal}
          onCancel={() => setSettingModal(false)}
          onConfirm={() => setSettingModal(false)}
        />
      </InstallerLayout>
    </>
  );
};

export default SetupPage;

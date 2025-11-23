import {useEffect, useRef, useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {InstallerLayout} from '../components/installer/InstallerLayout';
import {LogViewer} from '../components/installer/LogViewer';
import {ProgressBar} from '../components/installer/ProgressBar';
import {PathSelector} from '../components/installer/PathSelector';
import {StorageUtil} from "@/lib/storage";
import {BaseBackendInterface} from "@/types/app";
import {listen} from "@tauri-apps/api/event";
import {useGlobalLogStore} from "@/store/globalLogStore.ts";
import {useWebSocketStore} from "@/store/websocketStore.ts";
import {formatIsoToReadableTime} from "@/lib/utils.ts";
import {useTheme} from "@/hooks/useTheme.tsx";
import CButton from "@/components/ui/CButton.tsx";
import ConfigEditorModal from "@/components/installer/ConfigEditor.tsx";
import {exit} from '@tauri-apps/plugin-process';
import {useTranslation} from "react-i18next";

function createResource<T>(promise: Promise<T>) {
  let status = "pending";
  let result: T;
  let suspender = promise.then(
    (r) => {
      status = "success";
      result = r;
    },
    (e) => {
      status = "error";
      result = e;
    }
  );
  return {
    read(): T {
      if (status === "pending") throw suspender;
      if (status === "error") throw result;
      return result!;
    },
  };
}

const init = useWebSocketStore.getState().init;
const configRes = createResource(init())

const SetupPage = () => {
  const [started, setStarted] = useState(false);
  const [settingModal, setSettingModal] = useState(false);
  const [config, setConfig] = useState<any>(null);
  const [installPath, setInstallPath] = useState("");
  const [setupPhase, setSetupPhase] = useState(true);
  const appendGlobalLog = useGlobalLogStore(e => e.appendGlobalLog);
  const setProgress = useGlobalLogStore(e => e.setProgress);
  const {t} = useTranslation();

  useEffect(() => {
    const unlisten = listen<{ message: string; level: string }>('installer://log', (event) => {
      appendGlobalLog({
        message: event.payload.message,
        level: event.payload.level as any,
        time: formatIsoToReadableTime(new Date().toISOString()),
      });
    });

    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<{ percentage: number; message: string }>('installer://progress', (event) => {
      setProgress({
        progress: event.payload.percentage,
        message: event.payload.message
      })
    });

    return () => {
      unlisten.then((f) => f());
    };
  }, []);
  const setupCompletedRef = useRef(false);

  useEffect(() => {
    if (setupCompletedRef.current) return;

    (async () => {
      // Fetch defaults
      const p = await invoke('get_default_path');
      setInstallPath(p as string);
      const c = await invoke('get_default_config');
      setConfig(c);

      if (setupPhase && StorageUtil.get("base_dir")) {
        setSetupPhase(false);
        await startInstall(StorageUtil.get("base_dir"), c);
      }
    })();

    setupCompletedRef.current = true;
  }, []);

  const startInstall = async (base_dir: string | null = null, base_config: any | null = null) => {
    setSetupPhase(false);
    setStarted(true);
    try {
      const ret: BaseBackendInterface = await invoke('start_installer', {
        "installPath": base_dir || installPath,
        "setupConfig": base_config || config
      });
      StorageUtil.set("base_dir", base_dir || installPath);
      StorageUtil.set("baseBackendAddr", ret.baseBackendAddr);
      StorageUtil.set("baseBackendPort", ret.baseBackendPort);
      StorageUtil.set("SECRET", ret.serviceSecret)
      useWebSocketStore.setState(state => ({...state, _secret: ret.serviceSecret}))
      configRes.read();
    } catch (error) {
      StorageUtil.set("base_dir", null);
      console.error(error);
      setStarted(false);
      setSetupPhase(true); // Go back to set up on failure
    }
  };

  const {theme} = useTheme();

  return (
    <>
      <div
        className="fixed inset-0 bg-[var(--color-slate-100)] dark:bg-[oklch(12.9%_0.042_264.695)] overflow-hidden z-1">
        <img
          src={theme === "light" ? "/images/bg-light.webp" : "/images/bg-dark.webp"}
          alt="Loading BG"
          className="w-full h-full object-cover object-center"
        />
      </div>
      <InstallerLayout title={t("installer.title.wizard")}>

        <div
          className="flex flex-col gap-2 max-w-3xl mx-auto w-full bg-background px-5 md:px-20 py-5 backdrop-blur supports-[backdrop-filter]:bg-background/85 md:py-10 rounded-xl shadow-2xl shadow-slate-800">
          <div className="text-center space-y-2">
            <h2 className="text-2xl font-bold">{t("installer.title")}</h2>
            <p className="text-muted-foreground">
              {setupPhase ? t("installer.subtitle.stage_1") : t("installer.subtitle.stage_2")}
            </p>
          </div>

          <div className="space-y-1">
            {setupPhase && config && (
              <div className="space-y-1 animate-in fade-in slide-in-from-bottom-4 duration-500">
                <PathSelector path={installPath} setPath={setInstallPath}/>
                <div className="flex justify-around pt-4 gap-2 flex-col md:flex-row max-md:w-full">
                  <CButton onClick={async () => await exit(0)} className="md:w-48" variant="danger">
                    {t("installer.exit")}
                  </CButton>
                  <CButton onClick={() => setSettingModal(true)} className="md:w-48" variant="secondary">
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
                <ProgressBar/>
                <LogViewer/>
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
}

export default SetupPage;
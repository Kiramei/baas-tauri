import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { exit } from "@tauri-apps/plugin-process";
import { Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import StorageUtil from "@/shared/StorageManager";
import { waitForNormal, useWebSocketStore } from "@/store/WebsocketStore.ts";
import { useGlobalLogStore } from "@/store/GlobalLogStore.ts";
import { useTheme } from "@/context/ThemeProvider";
import CButton from "@/components/ui/CButton.tsx";
import { Button } from "@/components/ui/Button.tsx";
import { Modal } from "@/components/ui/Modal.tsx";
import { Toaster } from "@/components/ui/Sonner.tsx";
import ConfigEditorModal from "@/components/updater/ConfigEditor.tsx";
import TermViewer from "@/components/updater/TermViewer.tsx";
import PathSelector from "@/components/updater/PathSelector";
import InstallerLayout from "@/components/updater/InstallerLayout";

interface UpdaterConfig {
  general?: {
    channel?: "stable" | "dev";
    mirrorcCdk?: string;
  };
  paths?: {
    baasRootPath?: string;
  };
}

interface StartupState {
  configPath: string;
  config: UpdaterConfig;
  defaultInstallPath: string;
  baasRootExistsNonEmpty: boolean;
}

interface BackendReadyPayload {
  baseBackendAddr: string;
  baseBackendPort: number;
}

interface FailureInfo {
  step: string;
  message: string;
}

const authReadyPhases = new Set(["server_verified", "waiting_password", "authenticated"]);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const randomPassword = () => {
  if (globalThis.crypto?.randomUUID) {
    return `baas-${globalThis.crypto.randomUUID()}`;
  }
  return `baas-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const resetWebsocketRuntimeState = () => {
  const state = useWebSocketStore.getState();
  Object.values(state.connections).forEach((connection) => connection?.close());
  useWebSocketStore.setState({
    connections: {},
    pendingCallbacks: {},
    logStore: {},
    configStore: {},
    staticStore: {},
    eventStore: {},
    updateStore: {},
    statusStore: {},
    versionStore: {},
    _all_data_initialized: false,
    _heartbeat_time: 0,
    _initiating: false,
    _auth_phase: "idle",
    _auth_error: null,
    _server_initialized: false,
    _server_verified: false,
    _pwd_epoch: 0,
    _control: null,
    _session: null,
  });
};

const SetupPage = () => {
  const [started, setStarted] = useState(false);
  const [settingModal, setSettingModal] = useState(false);
  const [config, setConfig] = useState<UpdaterConfig | null>(null);
  const [installPath, setInstallPath] = useState("");
  const [setupPhase, setSetupPhase] = useState(true);
  const [failure, setFailure] = useState<FailureInfo | null>(null);
  const setupCompletedRef = useRef(false);
  const abortingRef = useRef(false);
  const terminalLogData = useGlobalLogStore((state) => state.terminalLogData);
  const { t } = useTranslation();
  const { theme } = useTheme();

  const persistConfig = useCallback(
    async (path = installPath, nextConfig = config) => {
      const updated = await invoke<UpdaterConfig>("updater_update_config", {
        request: {
          baasRootPath: path,
          channel: nextConfig?.general?.channel ?? "stable",
          mirrorcCdk: nextConfig?.general?.mirrorcCdk ?? "",
        },
      });
      setConfig(updated);
      return updated;
    },
    [config, installPath]
  );

  const startInstall = useCallback(
    async (path = installPath, nextConfig = config) => {
      const targetPath = path || installPath;
      abortingRef.current = false;
      setFailure(null);
      setSetupPhase(false);
      setStarted(true);
      StorageUtil.set("base_dir", targetPath);
      try {
        await persistConfig(targetPath, nextConfig);
        await invoke("updater_start_workflow", {
          request: {
            installPath: targetPath,
            launch: true,
          },
        });
      } catch (error) {
        StorageUtil.remove("base_dir");
        setFailure({
          step: "start",
          message: error instanceof Error ? error.message : String(error),
        });
        setStarted(false);
        setSetupPhase(true);
      }
    },
    [config, installPath, persistConfig]
  );

  const ensureAutoPassword = () => {
    let password = StorageUtil.get<string>("baasAutoPassword");
    if (!password) {
      password = randomPassword();
      StorageUtil.set("baasAutoPassword", password);
    }
    return password;
  };

  const authenticateBackend = useCallback(async (payload: BackendReadyPayload) => {
    StorageUtil.set("baseBackendAddr", payload.baseBackendAddr);
    StorageUtil.set("baseBackendPort", payload.baseBackendPort);
    resetWebsocketRuntimeState();

    const password = ensureAutoPassword();
    const deadline = Date.now() + 30_000;
    let lastError: unknown = null;

    while (
      Date.now() < deadline &&
      !authReadyPhases.has(useWebSocketStore.getState()._auth_phase)
    ) {
      try {
        await useWebSocketStore.getState().startAuthFlow();
        await waitForNormal(
          () => useWebSocketStore.getState()._auth_phase,
          (phase) => authReadyPhases.has(phase) || phase === "idle" || phase === "revoked",
          3_000
        );
      } catch (error) {
        lastError = error;
      }
      if (!authReadyPhases.has(useWebSocketStore.getState()._auth_phase)) {
        await delay(750);
      }
    }

    if (!authReadyPhases.has(useWebSocketStore.getState()._auth_phase)) {
      throw new Error(
        useWebSocketStore.getState()._auth_error ||
          (lastError instanceof Error
            ? lastError.message
            : "Backend authentication endpoint is not ready.")
      );
    }

    if (useWebSocketStore.getState()._auth_phase !== "authenticated") {
      await useWebSocketStore.getState().submitPassword(password);
      await waitForNormal(
        () => useWebSocketStore.getState()._auth_phase,
        (phase) => phase === "authenticated" || phase === "idle" || phase === "revoked",
        30_000
      );
    }

    if (useWebSocketStore.getState()._auth_phase !== "authenticated") {
      throw new Error(
        useWebSocketStore.getState()._auth_error ??
          "Automatic login failed. Existing backend password may be different."
      );
    }

    await useWebSocketStore.getState().init();
  }, []);

  const handleAbort = async () => {
    abortingRef.current = true;
    try {
      await invoke("updater_abort_workflow", {
        request: {
          cleanup: true,
        },
      });
    } finally {
      setStarted(false);
      setSetupPhase(true);
    }
  };

  const copyFailureLogs = () => {
    const text = terminalLogData
      .map((log) => `[${log.time}] [${log.level.toUpperCase()}] ${log.message}`)
      .join("\n");
    void navigator.clipboard.writeText(text);
    toast.success("Logs copied to clipboard");
  };

  useEffect(() => {
    const unlisten = listen<BackendReadyPayload>("updater://backend-ready", async (event) => {
      try {
        await authenticateBackend(event.payload);
      } catch (error) {
        setFailure({
          step: "auth",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });

    return () => {
      unlisten.then((f) => f());
    };
  }, [authenticateBackend]);

  useEffect(() => {
    if (setupCompletedRef.current) return;
    setupCompletedRef.current = true;

    (async () => {
      try {
        const startup = await invoke<StartupState>("updater_get_startup_state");
        const root = startup.config.paths?.baasRootPath || startup.defaultInstallPath;
        setInstallPath(root);
        setConfig(startup.config);

        if (startup.baasRootExistsNonEmpty && root) {
          await startInstall(root, startup.config);
        }
      } catch (error) {
        setFailure({
          step: "startup",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }, [startInstall]);

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
              <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 mt-4">
                {/*<ProgressBar />*/}
                <TermViewer
                  onAbort={handleAbort}
                  onFailure={(nextFailure) => {
                    if (!abortingRef.current) setFailure(nextFailure);
                  }}
                  onSessionFinished={(success) => {
                    if (!success && !abortingRef.current) {
                      setFailure({
                        step: "workflow",
                        message: "Updater workflow did not complete successfully.",
                      });
                    }
                  }}
                />
              </div>
            )}
          </div>
        </div>
        <ConfigEditorModal
          config={config ?? {}}
          setConfig={setConfig}
          open={settingModal}
          onCancel={() => setSettingModal(false)}
          onConfirm={async () => {
            await persistConfig();
            setSettingModal(false);
          }}
        />
      </InstallerLayout>
      <Modal
        isOpen={failure !== null}
        onClose={() => setFailure(null)}
        title="Setup Error"
        width={55}
      >
        <div className="space-y-3">
          <div className="text-sm">
            <div className="font-medium text-red-500">{failure?.step}</div>
            <div className="mt-1 whitespace-pre-wrap text-slate-700 dark:text-slate-200">
              {failure?.message}
            </div>
          </div>
          <div className="rounded-md bg-slate-950 text-slate-100 p-3 max-h-60 overflow-auto text-xs font-mono">
            {terminalLogData.length === 0
              ? "No structured logs captured."
              : terminalLogData.map((log, index) => (
                  <div key={`${log.time}-${index}`}>
                    [{log.time}] [{log.level.toUpperCase()}] {log.message}
                  </div>
                ))}
          </div>
          <div className="flex justify-end">
            <Button variant="outline" onClick={copyFailureLogs}>
              <Copy className="w-4 h-4 mr-2" />
              Copy Logs
            </Button>
          </div>
        </div>
      </Modal>
      <Toaster />
    </>
  );
};

export default SetupPage;

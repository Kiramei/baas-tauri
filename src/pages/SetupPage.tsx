import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@/shared/TauriInvoke";
import { listen } from "@tauri-apps/api/event";
import { exit } from "@tauri-apps/plugin-process";
import { Copy, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import StorageUtil from "@/shared/StorageManager";
import { waitForNormal, useWebSocketStore } from "@/store/WebsocketStore";
import { useGlobalLogStore } from "@/store/GlobalLogStore";
import { useTheme } from "@/context/ThemeProvider";
import { reloadWithoutPrompt } from "@/shared/reload";
import CButton from "@/components/ui/CButton.tsx";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal.tsx";
import { Toaster } from "@/components/ui/Sonner";
import ConfigEditorModal from "@/components/updater/ConfigEditor.tsx";
import TermViewer from "@/components/updater/TermViewer.tsx";
import PathSelector from "@/components/updater/PathSelector";
import InstallerLayout from "@/components/updater/InstallerLayout";

interface UpdaterConfig {
  general?: {
    channel?: "stable" | "dev";
    mirrorc_cdk?: string;
    mirrorcCdk?: string;
    no_update?: boolean;
    noUpdate?: boolean;
    backend_runtime?: "python" | "cpp";
    backendRuntime?: "python" | "cpp";
    transport?: "websocket" | "pipe";
  };
  paths?: {
    baas_root_path?: string;
    baasRootPath?: string;
  };
}

interface StartupState {
  configPath: string;
  config: UpdaterConfig;
  defaultInstallPath: string;
  installPath: string;
  portable: boolean;
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

const setupMirrorcCdk = (config: UpdaterConfig | null | undefined) =>
  config?.general?.mirrorc_cdk || config?.general?.mirrorcCdk || "";

const setupNoUpdate = (config: UpdaterConfig | null | undefined) =>
  Boolean(config?.general?.no_update ?? config?.general?.noUpdate ?? false);

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

/** Renders the setup page component. */
const SetupPage = () => {
  const [started, setStarted] = useState(false);
  const [settingModal, setSettingModal] = useState(false);
  const [config, setConfig] = useState<UpdaterConfig | null>(null);
  const [installPath, setInstallPath] = useState("");
  const [portable, setPortable] = useState(false);
  const [setupPhase, setSetupPhase] = useState(true);
  const [failure, setFailure] = useState<FailureInfo | null>(null);
  const setupCompletedRef = useRef(false);
  const abortingRef = useRef(false);
  const pendingWorkflowRef = useRef<{ path: string; config: UpdaterConfig | null } | null>(null);
  const workflowStartedRef = useRef(false);
  const cppStartupRef = useRef(false);
  const terminalLogData = useGlobalLogStore((state) => state.terminalLogData);
  const { t } = useTranslation();
  const { theme } = useTheme();

  const showWorkflowFailure = useCallback((nextFailure: FailureInfo, preserveExisting = false) => {
    pendingWorkflowRef.current = null;
    workflowStartedRef.current = false;
    setFailure((current) => (preserveExisting ? (current ?? nextFailure) : nextFailure));
  }, []);

  const persistConfig = useCallback(
    async (path = installPath, nextConfig = config) => {
      const updated = await invoke<UpdaterConfig>("updater_update_config", {
        request: {
          baasRootPath: path,
          channel: nextConfig?.general?.channel ?? "stable",
          mirrorcCdk: setupMirrorcCdk(nextConfig),
          noUpdate: setupNoUpdate(nextConfig),
          transport: nextConfig?.general?.transport ?? "pipe",
        },
      });
      setConfig(updated);
      return updated;
    },
    [config, installPath]
  );

  const startInstall = useCallback(
    async (path = installPath, nextConfig = config) => {
      const targetPath = portable ? "." : path || installPath;
      abortingRef.current = false;
      workflowStartedRef.current = false;
      pendingWorkflowRef.current = { path: targetPath, config: nextConfig };
      setFailure(null);
      setSetupPhase(false);
      setStarted(true);
      StorageUtil.set("base_dir", targetPath);
    },
    [config, installPath, portable]
  );

  const startWorkflowWhenTerminalReady = useCallback(async () => {
    if (workflowStartedRef.current || !pendingWorkflowRef.current) return;
    workflowStartedRef.current = true;
    const { path, config: requestConfig } = pendingWorkflowRef.current;
    StorageUtil.set("base_dir", path);
    try {
      await persistConfig(path, requestConfig);
      const backendRuntime =
        requestConfig?.general?.backend_runtime ??
        requestConfig?.general?.backendRuntime ??
        "python";
      await invoke("updater_start_workflow", {
        request: {
          installPath: path,
          launch: backendRuntime !== "cpp",
        },
      });
    } catch (error) {
      showWorkflowFailure({
        step: "start",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      pendingWorkflowRef.current = null;
    }
  }, [persistConfig, showWorkflowFailure]);

  const ensureAutoPassword = (forceNew = false) => {
    let password = StorageUtil.get<string>("baasAutoPassword");
    if (!password || forceNew) {
      password = randomPassword();
      StorageUtil.set("baasAutoPassword", password);
    }
    return password;
  };

  const authenticateBackend = useCallback(
    async (payload: BackendReadyPayload, forceNewPassword = false) => {
      StorageUtil.set("baseBackendAddr", payload.baseBackendAddr);
      StorageUtil.set("baseBackendPort", payload.baseBackendPort);
      resetWebsocketRuntimeState();

      const password = ensureAutoPassword(forceNewPassword);
      const deadline = Date.now() + 30_000;
      let lastError: unknown = null;

      while (
        Date.now() < deadline &&
        !authReadyPhases.has(useWebSocketStore.getState()._auth_phase)
      ) {
        try {
          await useWebSocketStore.getState().startAuthFlow(true);
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
    },
    []
  );

  const finishCppWorkflow = useCallback(async () => {
    if (cppStartupRef.current) return;
    cppStartupRef.current = true;
    try {
      const payload = await invoke<BackendReadyPayload>("backend_cpp_transport_start", {
        mode: "websocket",
      });
      await authenticateBackend(payload);
      reloadWithoutPrompt();
    } catch (error) {
      showWorkflowFailure({
        step: "cpp-startup",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      cppStartupRef.current = false;
    }
  }, [authenticateBackend, showWorkflowFailure]);

  /** Handles the handle abort interaction. */
  const handleAbort = async () => {
    abortingRef.current = true;
    pendingWorkflowRef.current = null;
    workflowStartedRef.current = false;
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

  const returnToSetup = async () => {
    setFailure(null);
    try {
      await handleAbort();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    const unlisten = listen<BackendReadyPayload>("updater://backend-ready", async (event) => {
      try {
        await authenticateBackend(event.payload);
      } catch (error) {
        try {
          const recovered = await invoke<BackendReadyPayload>(
            "updater_reset_backend_auth_and_restart"
          );
          await authenticateBackend(recovered, true);
          reloadWithoutPrompt();
        } catch (retryError) {
          const firstMessage = error instanceof Error ? error.message : String(error);
          const retryMessage =
            retryError instanceof Error ? retryError.message : String(retryError);
          setFailure({
            step: "auth",
            message: `${firstMessage}\n\nBackend auth reset retry failed: ${retryMessage}`,
          });
        }
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
        await invoke("updater_abort_workflow", {
          request: {
            cleanup: false,
            emitEvents: false,
          },
        }).catch(() => undefined);
        const startup = await invoke<StartupState>("updater_get_startup_state");
        const root = startup.installPath || startup.defaultInstallPath;
        setPortable(startup.portable);
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
              {setupPhase ? t("installer.subtitle.stage1") : t("installer.subtitle.stage2")}
            </p>
          </div>

          <div className="space-y-1">
            {setupPhase && config && (
              <div className="space-y-1 animate-in fade-in slide-in-from-bottom-4 duration-500">
                <PathSelector path={installPath} setPath={setInstallPath} disabled={portable} />
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
                <TermViewer
                  onAbort={handleAbort}
                  onReady={startWorkflowWhenTerminalReady}
                  onFailure={(nextFailure) => {
                    if (!abortingRef.current) showWorkflowFailure(nextFailure);
                  }}
                  onSessionFinished={(success) => {
                    if (!success && !abortingRef.current) {
                      showWorkflowFailure(
                        {
                          step: "workflow",
                          message: "Updater workflow did not complete successfully.",
                        },
                        true
                      );
                    } else if (
                      success &&
                      (config?.general?.backend_runtime ?? config?.general?.backendRuntime) ===
                        "cpp"
                    ) {
                      void finishCppWorkflow();
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
        width={72}
      >
        <div className="space-y-3 max-h-[78vh] overflow-y-auto pr-1">
          <div className="text-sm max-h-36 overflow-auto pr-1">
            <div className="font-medium text-red-500">{failure?.step}</div>
            <div className="mt-1 whitespace-pre-wrap text-slate-700 dark:text-slate-200">
              {failure?.message}
            </div>
          </div>
          <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-200">
            Return to setup to change the install path or retry. Copy logs before reporting this
            issue.
          </div>
          <div className="rounded-md bg-slate-950 text-slate-100 p-3 max-h-[44vh] overflow-auto text-xs font-mono whitespace-pre-wrap break-words">
            {terminalLogData.length === 0
              ? "No structured logs captured."
              : terminalLogData.map((log, index) => (
                  <div key={`${log.time}-${index}`} className="leading-5">
                    [{log.time}] [{log.level.toUpperCase()}] {log.message}
                  </div>
                ))}
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="secondary" onClick={returnToSetup}>
              <RotateCcw className="w-4 h-4 mr-2" />
              Back to Setup
            </Button>
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

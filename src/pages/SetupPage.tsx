import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@/shared/TauriInvoke";
import { listen } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import { exit } from "@tauri-apps/plugin-process";
import { CheckCircle2, Copy, Loader2, RotateCcw } from "lucide-react";
import { useAppTranslation } from "@/shared/useAppTranslation";
import { toast } from "sonner";

import StorageUtil from "@/shared/StorageManager";
import { loadLocale } from "@/shared/I18nTranslator";
import { waitForNormal, useWebSocketStore } from "@/store/WebsocketStore";
import { useGlobalLogStore } from "@/store/GlobalLogStore";
import { reloadWithoutPrompt } from "@/shared/reload";
import CButton from "@/components/ui/CButton.tsx";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal.tsx";
import { Toaster } from "@/components/ui/Sonner";
import ConfigEditorModal from "@/components/updater/ConfigEditor.tsx";
import TermViewer from "@/components/updater/TermViewer.tsx";
import PathSelector from "@/components/updater/PathSelector";
import InstallerLayout from "@/components/updater/InstallerLayout";
import InstallPreflight from "@/components/updater/InstallPreflight";
import { useSetUISettings, useUISetting } from "@/context/UISettingsProvider";
import { useTheme } from "@/context/ThemeProvider";
import { normalizeTransportMode } from "@/transport/factory";
import { shouldCancelInstallerFromEscape } from "@/shared/InstallerCancelShortcut";

interface UpdaterConfig {
  general?: {
    channel?: "stable" | "dev";
    mirrorc_cdk_configured?: boolean;
    no_update?: boolean;
    noUpdate?: boolean;
    transport?: "websocket" | "pipe" | "shm";
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
  legacyMigrationAvailable?: boolean;
  legacyMigrationPending?: LegacyAppearance | null;
}

interface LegacyAppearance {
  installPath: string;
  language?: string | null;
  theme?: string | null;
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
  const [installDisplayPath, setInstallDisplayPath] = useState("");
  const [portable, setPortable] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const [setupPhase, setSetupPhase] = useState(true);
  const [failure, setFailure] = useState<FailureInfo | null>(null);
  const [backendReady, setBackendReady] = useState<BackendReadyPayload | null>(null);
  const [entering, setEntering] = useState(false);
  const enteringRef = useRef(false);
  const setupCompletedRef = useRef(false);
  const abortingRef = useRef(false);
  const pendingWorkflowRef = useRef<{
    path: string;
    config: UpdaterConfig | null;
    migrate: boolean;
  } | null>(null);
  const migrationAttemptRef = useRef<{ path: string; fallbackPath: string } | null>(null);
  const workflowStartedRef = useRef(false);
  const terminalLogData = useGlobalLogStore((state) => state.terminalLogData);
  const { t } = useAppTranslation();
  const { setTheme } = useTheme();
  const setUISettings = useSetUISettings();
  const autoEnterAfterInstall = useUISetting(
    (settings) => settings.autoEnterAfterInstall !== false
  );
  const transport = config?.general?.transport ?? normalizeTransportMode(undefined);

  const showWorkflowFailure = useCallback((nextFailure: FailureInfo, preserveExisting = false) => {
    pendingWorkflowRef.current = null;
    workflowStartedRef.current = false;
    setFailure((current) => (preserveExisting ? (current ?? nextFailure) : nextFailure));
  }, []);

  const persistConfig = useCallback(
    async (path = installPath, nextConfig = config, cdk?: string) => {
      const updated = await invoke<UpdaterConfig>("updater_update_config", {
        request: {
          baasRootPath: path,
          channel: nextConfig?.general?.channel ?? "stable",
          ...(cdk === undefined ? {} : { mirrorcCdk: cdk }),
          noUpdate: setupNoUpdate(nextConfig),
          transport: nextConfig?.general?.transport ?? normalizeTransportMode(undefined),
        },
      });
      setConfig(updated);
      return updated;
    },
    [config, installPath]
  );

  const startInstall = useCallback(
    async (path = installPath, nextConfig = config, migrate = false) => {
      const targetPath = portable ? "." : path || installPath;
      abortingRef.current = false;
      workflowStartedRef.current = false;
      pendingWorkflowRef.current = { path: targetPath, config: nextConfig, migrate };
      setFailure(null);
      setBackendReady(null);
      setSetupPhase(false);
      setStarted(true);
      if (!migrate) StorageUtil.set("base_dir", targetPath);
    },
    [config, installPath, portable]
  );

  const startWorkflowWhenTerminalReady = useCallback(async () => {
    if (workflowStartedRef.current || !pendingWorkflowRef.current) return;
    workflowStartedRef.current = true;
    const pendingWorkflow = pendingWorkflowRef.current;
    const { path, config: requestConfig, migrate } = pendingWorkflow;
    try {
      if (!migrate) {
        StorageUtil.set("base_dir", path);
        await persistConfig(path, requestConfig);
      }
      if (abortingRef.current || pendingWorkflowRef.current !== pendingWorkflow) return;
      await invoke("updater_start_workflow", {
        request: {
          installPath: path,
          launch: true,
          legacyMigration: migrate,
        },
      });
    } catch (error) {
      if (abortingRef.current || pendingWorkflowRef.current !== pendingWorkflow) return;
      showWorkflowFailure({
        step: "start",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (pendingWorkflowRef.current === pendingWorkflow) pendingWorkflowRef.current = null;
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
          // Desktop workflows launch the configured native endpoint directly.
          // Android still uses its own embedded-runtime transport bootstrap.
          await useWebSocketStore.getState().startAuthFlow(!__WITH_ANDROID__);
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
            (lastError instanceof Error ? lastError.message : t("installer.backendNotReady"))
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
        throw new Error(useWebSocketStore.getState()._auth_error ?? t("installer.autoLoginFailed"));
      }

      await useWebSocketStore.getState().init();
    },
    [t]
  );

  const enterBackend = useCallback(
    async (payload: BackendReadyPayload, automatic = false) => {
      if (enteringRef.current || abortingRef.current) return;
      enteringRef.current = true;
      setEntering(true);
      try {
        await authenticateBackend(payload);
      } catch (error) {
        if (abortingRef.current) return;
        try {
          const recovered = await invoke<BackendReadyPayload>(
            "updater_reset_backend_auth_and_restart"
          );
          if (abortingRef.current) return;
          setBackendReady(recovered);
          await authenticateBackend(recovered, true);
          if (automatic) reloadWithoutPrompt();
        } catch (retryError) {
          const firstMessage = error instanceof Error ? error.message : String(error);
          const retryMessage =
            retryError instanceof Error ? retryError.message : String(retryError);
          showWorkflowFailure({
            step: "auth",
            message: `${firstMessage}\n\nBackend auth reset retry failed: ${retryMessage}`,
          });
        }
      } finally {
        enteringRef.current = false;
        setEntering(false);
      }
    },
    [authenticateBackend, showWorkflowFailure]
  );

  /** Handles the handle abort interaction. */
  const handleAbort = useCallback(async () => {
    if (abortingRef.current) return;
    abortingRef.current = true;
    pendingWorkflowRef.current = null;
    workflowStartedRef.current = false;
    setBackendReady(null);
    try {
      await invoke("updater_abort_workflow", {
        request: {
          cleanup: true,
        },
      });
    } finally {
      setStarted(false);
      setSetupPhase(true);
      const migration = migrationAttemptRef.current;
      if (migration) {
        migrationAttemptRef.current = null;
        setMigrating(false);
        setInstallPath(migration.fallbackPath);
      }
    }
  }, []);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (
        !shouldCancelInstallerFromEscape(event, {
          running: started && !setupPhase && backendReady === null,
          blocked: settingModal || failure !== null,
          pending: abortingRef.current,
        })
      )
        return;
      const overlayOpen = Array.from(
        document.querySelectorAll<HTMLElement>(
          "[role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox']"
        )
      ).some(
        (element) =>
          element.getClientRects().length > 0 &&
          !element.closest("[aria-hidden='true'], [hidden], [inert]")
      );
      if (overlayOpen) return;

      event.preventDefault();
      event.stopPropagation();
      void handleAbort().catch((error) => {
        toast.error(error instanceof Error ? error.message : String(error));
      });
    };
    // xterm handles keys itself, so listen before its terminal input consumes Escape.
    window.addEventListener("keydown", handleEscape, true);
    return () => window.removeEventListener("keydown", handleEscape, true);
  }, [started, setupPhase, backendReady, settingModal, failure, handleAbort]);

  const copyFailureLogs = () => {
    const text = terminalLogData
      .map((log) => `[${log.time}] [${log.level.toUpperCase()}] ${log.message}`)
      .join("\n");
    void navigator.clipboard.writeText(text);
    toast.success(t("log.copied"));
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
    const unlisten = listen<BackendReadyPayload>("updater://backend-ready", (event) => {
      if (abortingRef.current || !workflowStartedRef.current) return;
      const ready = async () => {
        const migration = migrationAttemptRef.current;
        if (migration) {
          // Commit the migrated install path only after the backend is ready.
          await StorageUtil.setDurable("base_dir", migration.path);
          if (abortingRef.current || migrationAttemptRef.current !== migration) return;
          migrationAttemptRef.current = null;
          setMigrating(false);
        }
        setBackendReady(event.payload);
        if (autoEnterAfterInstall) void enterBackend(event.payload, true);
      };
      void ready().catch((error) => {
        if (!abortingRef.current) {
          showWorkflowFailure({
            step: "configuration",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
    });

    return () => {
      unlisten.then((f) => f());
    };
  }, [autoEnterAfterInstall, enterBackend, showWorkflowFailure]);

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
        const configSeparator = Math.max(
          startup.configPath.lastIndexOf("/"),
          startup.configPath.lastIndexOf("\\")
        );
        const configIsAbsolute = /^(?:[A-Za-z]:[\\/]|[\\/])/.test(startup.configPath);
        setInstallDisplayPath(
          startup.portable && configIsAbsolute && configSeparator >= 0
            ? startup.configPath.slice(0, configSeparator + 1)
            : startup.defaultInstallPath
        );
        setPortable(startup.portable);
        setInstallPath(root);
        setConfig(startup.config);
        let migration = startup.legacyMigrationPending;
        let showManualSetup = false;
        if (startup.legacyMigrationAvailable) {
          const accept = await ask(t("installer.legacyMigrationPrompt"), {
            title: t("installer.legacyMigrationTitle"),
            okLabel: t("installer.legacyMigrationYes"),
            cancelLabel: t("installer.legacyMigrationNo"),
          });
          try {
            migration = await invoke<LegacyAppearance | null>("updater_decide_legacy_migration", {
              accept,
            });
            showManualSetup = accept && migration === null;
          } catch {
            migration = null;
            showManualSetup = true;
          }
        }
        if (showManualSetup) {
          toast.warning(t("installer.legacyMigrationFallback"));
          return;
        }

        if (migration) {
          const path = startup.portable ? "." : migration.installPath;
          migrationAttemptRef.current = { path, fallbackPath: root };
          setMigrating(true);
          setInstallPath(path);
          const { language, theme } = migration;
          if (theme === "light" || theme === "dark") {
            setTheme(theme);
            setUISettings((settings) => ({ ...settings, theme }));
          }
          if (language && (await loadLocale(language))) {
            setUISettings((settings) => ({ ...settings, lang: language }));
          }
          await startInstall(path, startup.config, true);
        } else if (startup.baasRootExistsNonEmpty && root) {
          await startInstall(root, startup.config);
        }
      } catch (error) {
        setConfig((current) => current ?? {});
        setFailure({
          step: "startup",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }, [setTheme, setUISettings, startInstall, t]);

  return (
    <>
      <InstallerLayout title={t("installer.title.wizard")} filling={!setupPhase && started}>
        {setupPhase && config && (
          <InstallPreflight
            channelLabel={
              config.general?.channel === "dev" ? t("updateChannel.dev") : t("updateChannel.stable")
            }
            transportLabel={
              transport === "shm"
                ? t("transport.shm")
                : transport === "pipe"
                  ? t("transport.pipe")
                  : t("transport.websocket")
            }
            onAdvanced={() => setSettingModal(true)}
            onCancel={() => void exit(0)}
            onStart={() => void startInstall()}
          >
            <PathSelector
              path={installPath}
              displayPath={installDisplayPath}
              setPath={setInstallPath}
              disabled={portable || migrating}
            />
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              {portable ? t("installer.portableHint") : t("installer.directoryHint")}
            </p>
          </InstallPreflight>
        )}

        {setupPhase && !config && (
          <div
            className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground"
            role="status"
          >
            <Loader2 className="size-4 animate-spin" />
            {t("version.fetching")}
          </div>
        )}
        {!setupPhase && started && (
          <div
            className="flex min-h-0 flex-1 flex-col"
            data-installer-phase={backendReady ? "completed" : "running"}
          >
            <TermViewer
              onAbort={backendReady ? undefined : handleAbort}
              onReady={startWorkflowWhenTerminalReady}
              onFailure={(nextFailure) => {
                if (!abortingRef.current) showWorkflowFailure(nextFailure);
              }}
              onSessionFinished={(success) => {
                if (!success && !abortingRef.current) {
                  showWorkflowFailure(
                    {
                      step: "workflow",
                      message: t("installer.workflowFailed"),
                    },
                    true
                  );
                }
              }}
            />
            {backendReady && (
              <div
                className="mt-2 flex shrink-0 flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2"
                role="status"
              >
                <div className="flex items-center gap-2.5 text-sm font-medium">
                  <CheckCircle2
                    className="size-5 text-blue-500"
                    strokeWidth={1.8}
                    aria-hidden="true"
                  />
                  {t("installer.completed")}
                </div>
                <CButton
                  disabled={entering}
                  onClick={() => void enterBackend(backendReady)}
                  className="h-8 min-w-28 px-4 py-1"
                >
                  {entering && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
                  {entering ? t("installer.entering") : t("installer.enter")}
                </CButton>
              </div>
            )}
          </div>
        )}
        {settingModal && (
          <ConfigEditorModal
            config={config ?? {}}
            setConfig={setConfig}
            open
            onCancel={() => setSettingModal(false)}
            onConfirm={async (cdk) => {
              await persistConfig(installPath, config, cdk);
              setSettingModal(false);
            }}
          />
        )}
      </InstallerLayout>
      <Modal
        isOpen={failure !== null}
        onClose={migrating ? () => void returnToSetup() : () => setFailure(null)}
        title={t("installer.errorTitle")}
        width={72}
      >
        <div className="space-y-3 max-h-[78vh] overflow-y-auto pr-1">
          <div className="text-sm max-h-36 overflow-auto pr-1">
            <div className="font-medium text-red-500">{failure?.step}</div>
            <div className="mt-1 whitespace-pre-wrap text-foreground">{failure?.message}</div>
          </div>
          <div className="rounded-lg border border-border bg-secondary/50 p-3 text-sm text-foreground">
            {t("installer.errorHint")}
          </div>
          <div className="rounded-md bg-slate-950 text-slate-100 p-3 max-h-[44vh] overflow-auto text-xs font-mono whitespace-pre-wrap break-words">
            {terminalLogData.length === 0
              ? t("installer.noStructuredLogs")
              : terminalLogData.map((log, index) => (
                  <div key={`${log.time}-${index}`} className="leading-5">
                    [{log.time}] [{log.level.toUpperCase()}] {log.message}
                  </div>
                ))}
          </div>
          <div className="modal-footer">
            <Button variant="secondary" onClick={returnToSetup}>
              <RotateCcw className="w-4 h-4 mr-2" />
              {t("installer.backToSetup")}
            </Button>
            <Button variant="outline" onClick={copyFailureLogs}>
              <Copy className="w-4 h-4 mr-2" />
              {t("settings.systemLogs.copy")}
            </Button>
          </div>
        </div>
      </Modal>
      <Toaster />
    </>
  );
};

export default SetupPage;

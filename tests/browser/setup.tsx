// The production SetupPage and xterm are mounted, but every native command/event is simulated.
import React from "react";
import { createRoot } from "react-dom/client";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import SetupPage from "../../src/pages/SetupPage";
import { ThemeProvider } from "../../src/context/ThemeProvider";
import { UISettingsProvider } from "../../src/context/UISettingsProvider";
import GlobalAppearanceEffects from "../../src/components/GlobalAppearanceEffects";
import { initI18n } from "../../src/shared/I18nTranslator";
import { useWebSocketStore } from "../../src/store/WebsocketStore";
import { useGlobalLogStore } from "../../src/store/GlobalLogStore";
import "../../src/styles/index.css";

const fixtureWindow = window as typeof window & { __BAAS_SETUP_FIXTURE__?: boolean };
if (
  !import.meta.env.DEV ||
  !__WITH_WEBUI__ ||
  __WITH_TAURI__ ||
  __WITH_ANDROID__ ||
  ("__TAURI_INTERNALS__" in window && !fixtureWindow.__BAAS_SETUP_FIXTURE__)
)
  throw new Error("Installer fixture only runs in an isolated Vite development browser");
fixtureWindow.__BAAS_SETUP_FIXTURE__ = true;
const query = new URLSearchParams(location.search);
const mode = query.get("state") || "preflight";
const portable = query.get("portable") === "1";
const previewInstallPath = "C:\\BAAS-Fixture";
const sessionId = "isolated-installer-preview";
const calls: string[] = [];
let authAttemptCount = 0;
const authAttemptListeners = new Set<() => void>();
const subscribeAuthAttempts = (listener: () => void) => {
  authAttemptListeners.add(listener);
  return () => authAttemptListeners.delete(listener);
};
const getAuthAttemptCount = () => authAttemptCount;
function AuthenticationCounter() {
  const count = React.useSyncExternalStore(subscribeAuthAttempts, getAuthAttemptCount);
  const entered = useWebSocketStore((state) => state._all_data_initialized);
  return (
    <>
      Auth attempts: <output data-fixture-auth-attempts="">{count}</output>
      <span className="ml-2">
        Entered: <output data-fixture-entered="">{String(entered)}</output>
      </span>
    </>
  );
}
function InstallerPreview() {
  const entered = useWebSocketStore((state) => state._all_data_initialized);
  return entered ? (
    <div className="flex h-full items-center justify-center" data-fixture-home="">
      已进入主页
    </div>
  ) : (
    <SetupPage />
  );
}
let cleanupAbortCount = 0;
const cleanupAbortListeners = new Set<() => void>();
const subscribeCleanupAborts = (listener: () => void) => {
  cleanupAbortListeners.add(listener);
  return () => cleanupAbortListeners.delete(listener);
};
const getCleanupAbortCount = () => cleanupAbortCount;
function CleanupAbortCounter() {
  const count = React.useSyncExternalStore(subscribeCleanupAborts, getCleanupAbortCount);
  return <output data-fixture-cleanup-aborts="">{count}</output>;
}
let timers: number[] = [];
const later = (callback: () => void, ms: number) => timers.push(window.setTimeout(callback, ms));
const cancelTimers = () => {
  timers.forEach(clearTimeout);
  timers = [];
};
const nativeFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input : input.url,
    location.href
  );
  if (url.origin !== location.origin || /^\/(?:api|android|system)(?:\/|$)/.test(url.pathname))
    return Promise.reject(new Error("Installer fixture blocked an API request"));
  return nativeFetch(input, init);
};
localStorage.setItem(
  "uiSettings",
  JSON.stringify({
    lang: query.get("lang") || "zh",
    theme: query.get("theme") || "light",
    idleAutoUpdate: false,
    autoEnterAfterInstall: query.get("autoEnter") !== "0",
  })
);
localStorage.setItem("theme", query.get("theme") || "light");
const config = {
  general: { channel: "dev", transport: "shm", no_update: false, mirrorc_cdk: "" },
  paths: { baas_root_path: portable ? "." : previewInstallPath },
};
const nodes = [
  ["main-repository", "Main Repository", "Fetch and verify the delivery commit", 0, 0],
  ["cpp-repository", "OCR Repository", "Fetch OCR models", 0, 1],
  ["uv-install", "Install UV", "Prepare the package manager", 0, 2],
  ["uv-compile", "Compile Dependencies", "Resolve requirements", 1, 0],
  ["uv-sync", "Sync Dependencies", "Install resolved packages", 2, 0],
].map(([taskId, name, description, stage, lane], index) => ({
  taskId,
  regionId: taskId,
  name,
  description,
  stage,
  lane,
  stepIndex: index + 1,
  stepTotal: 5,
  command: `fixture-only ${taskId}`,
}));
const edges = [
  { from: "main-repository", to: "uv-compile" },
  { from: "cpp-repository", to: "uv-compile" },
  { from: "uv-install", to: "uv-compile" },
  { from: "uv-compile", to: "uv-sync" },
];
const send = (name: string, payload: Record<string, unknown>) => {
  if (name === "updater://backend-ready" && mode !== "completed")
    throw new Error("Only the completed fixture can simulate backend readiness");
  return emit(name, { sessionId, ...payload });
};
function dashboard(tick: number) {
  const region = (title: string, lines: string[]) => [title, ...lines].join("\r\n");
  return (
    "\x1b[H\x1b[2J" +
    [
      region("\x1b[1;36m[01/05] Main Repository\x1b[0m", [
        "Checking installed delivery identity",
        "Fetching candidate source",
        "Verifying commit ancestry",
        `Receiving objects: ${Math.min(96, 30 + tick * 7)}%`,
        "Fixture output only — no Git process runs",
      ]),
      region("\x1b[1;36m[02/05] OCR Repository\x1b[0m", [
        "Preparing OCR assets",
        "Checking cached model files",
        "Selecting compatible platform",
        `Objects checked: ${17 + tick}`,
        "Fixture output only — no files are downloaded",
      ]),
      region("\x1b[1;36m[03/05] Install UV\x1b[0m", [
        "UV preview is ready",
        "Python preview is ready",
        "Dependency stages await repositories",
        "No interpreter or virtual environment is created",
        "Each running region: title + five body lines",
      ]),
    ].join("\r\n") +
    "\r\n"
  );
}
async function startPreview() {
  cancelTimers();
  await send("term:dashboard-cleared", {});
  await send("term:workflow-planned", { nodes, edges });
  for (const node of nodes.slice(0, 3))
    await send("term:task-started", { ...node, status: "running" });
  await send("term:chunk", { chunk: dashboard(0) });
  if (mode === "failure") {
    later(() => {
      void (async () => {
        await send("term:region-stable", {
          taskId: "main-repository",
          regionId: "main-repository",
          title: "[01/05] Main Repository",
          lines: ["Simulated source verification failure.", "No installation was performed."],
        });
        await send("term:task-status", {
          taskId: "main-repository",
          regionId: "main-repository",
          status: "failed",
          exitCode: 1,
          error: "Simulated source verification failure. This is an isolated layout preview.",
        });
        await send("term:session-finished", { success: false });
      })();
    }, 900);
  } else if (mode === "completed") {
    later(() => {
      void (async () => {
        for (const node of nodes)
          await send("term:task-status", {
            taskId: node.taskId,
            regionId: node.regionId,
            status: "success",
            exitCode: 0,
          });
        await send("term:chunk", { chunk: "\r\nFixture installation completed.\r\n" });
        await send("term:session-finished", { success: true });
        // All authentication methods below are mocked; this address is never contacted.
        await send("updater://backend-ready", {
          baseBackendAddr: "127.0.0.1",
          baseBackendPort: 8192,
        });
      })();
    }, 700);
  } else {
    for (let tick = 1; tick <= 8; tick++)
      later(() => {
        void send("term:chunk", { chunk: dashboard(tick) });
      }, tick * 1200);
  }
}

mockIPC(
  async (command, payload) => {
    if (command !== "updater_resize_term") calls.push(command);
    switch (command) {
      case "updater_get_startup_state":
        return {
          configPath: `${previewInstallPath}\\setup.toml`,
          config,
          portable,
          defaultInstallPath: previewInstallPath,
          installPath: portable ? "." : previewInstallPath,
          baasRootExistsNonEmpty: ["running", "failure", "completed"].includes(mode),
        };
      case "updater_update_config":
        return config;
      case "updater_start_workflow":
        await startPreview();
        return { sessionId };
      case "updater_abort_workflow":
        if (
          payload &&
          typeof payload === "object" &&
          "request" in payload &&
          (payload.request as { cleanup?: boolean } | undefined)?.cleanup === true
        ) {
          cleanupAbortCount += 1;
          cleanupAbortListeners.forEach((listener) => listener());
        }
        cancelTimers();
        return;
      case "updater_resize_term":
        return;
      case "updater_terminal_snapshot":
        return { sessionId, workflowPlan: { nodes, edges } };
      case "plugin:dialog|open":
        return "C:\\BAAS-Fixture";
      case "plugin:process|exit":
        return;
      default:
        throw new Error(`Installer fixture blocked native command: ${command}`);
    }
  },
  { shouldMockEvents: true }
);
useWebSocketStore.setState({
  connections: {},
  _auth_phase: "idle",
  _all_data_initialized: false,
  startAuthFlow: async () => {
    authAttemptCount += 1;
    authAttemptListeners.forEach((listener) => listener());
    useWebSocketStore.setState({ _auth_phase: "server_verified", _server_verified: true });
  },
  init: async () => {
    useWebSocketStore.setState({ _all_data_initialized: true });
  },
  submitPassword: async () => {
    useWebSocketStore.setState({ _auth_phase: "authenticated" });
  },
  connect: async () => {},
  recoverTransport: async () => {},
  trigger: () => {},
  triggerStream: () => {},
});
useGlobalLogStore.setState({ terminalLogData: [], globalLogData: [] });
await initI18n();
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    cancelTimers();
    clearMocks();
  });

createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <UISettingsProvider>
      <GlobalAppearanceEffects />
      <div
        className="flex h-full min-h-0 flex-col bg-background text-foreground"
        data-fixture-installer="isolated"
      >
        <header className="flex h-9 shrink-0 items-center gap-3 overflow-x-auto border-b border-border px-3 text-xs">
          <span className="shrink-0 text-muted-foreground">Simulation · no installation runs</span>
          <span className="shrink-0 text-muted-foreground">
            Cleanup aborts: <CleanupAbortCounter />
          </span>
          <span className="shrink-0 text-muted-foreground">
            <AuthenticationCounter />
          </span>
          {["preflight", "running", "failure", "completed"].map((state) => (
            <a
              key={state}
              href={`/tests/browser/setup.html?state=${state}&lang=${query.get("lang") || "zh"}&theme=${query.get("theme") || "light"}${portable ? "&portable=1" : ""}${query.get("autoEnter") === "0" ? "&autoEnter=0" : ""}`}
              className={`shrink-0 rounded px-2 py-1 ${mode === state ? "bg-secondary font-semibold" : "hover:bg-secondary"}`}
            >
              {state}
            </a>
          ))}
        </header>
        <div className="min-h-0 flex-1 overflow-hidden">
          <InstallerPreview />
        </div>
      </div>
    </UISettingsProvider>
  </ThemeProvider>
);

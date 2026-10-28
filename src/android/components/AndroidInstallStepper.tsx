import React, { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  Loader2,
  RotateCcw,
  TerminalSquare,
} from "lucide-react";
import { invoke } from "@/shared/TauriInvoke";
import { useAppTranslation } from "@/shared/useAppTranslation";
import { i18nKey } from "@/shared/I18nKeys";
import { useWebSocketStore } from "@/store/WebsocketStore";
import type { TranslationKey } from "@/types/i18n";

const Terminal = React.lazy(() => import("@/components/AndroidStartupTerminal"));

type StepState = "pending" | "running" | "done" | "failed";
type Channel = "stable" | "dev";

interface BootstrapStep {
  id?: string;
  title?: string;
  state?: string;
  detail?: string;
}

interface Bootstrap {
  stage?: string;
  error?: string;
  traceback?: string;
  installMessage?: string;
  backendInstalled?: boolean;
  steps?: BootstrapStep[];
  channel?: string;
  awaitingChannel?: boolean;
  currentStep?: string;
  channelFallback?: boolean;
}

interface StartupState {
  bootstrap?: Bootstrap;
  startupLog?: string;
  installPath?: string;
  channel?: string;
  channelSelected?: boolean;
  baasRootExistsNonEmpty?: boolean;
}

/** Step ids the bootstrap reports, in display order. */
const STEP_IDS = ["storage", "channel", "download", "extract", "adapt", "service"] as const;

const STEP_LABELS: Record<string, TranslationKey> = {
  storage: "androidSetup.stepStorage",
  channel: "androidSetup.stepChannel",
  download: "androidSetup.stepDownload",
  extract: "androidSetup.stepExtract",
  adapt: "androidSetup.stepAdapt",
  service: "androidSetup.stepService",
};

const STATE_LABELS: Record<string, TranslationKey> = {
  pending: "androidSetup.statePending",
  running: "androidSetup.stateRunning",
  done: "androidSetup.stateDone",
  failed: "androidSetup.stateFailed",
};

/** Maps a legacy stage name to the step that is currently executing. */
const stageIndex = (stage?: string) => {
  switch (stage) {
    case "channel":
      return 1;
    case "runtime":
      return 2;
    case "service":
      return 5;
    case "failed":
      return -1;
    default:
      return 0;
  }
};

/** Falls back to stage-derived rows only for a status file written by an older build. */
const normalizeSteps = (bootstrap: Bootstrap): { id: string; state: StepState; detail: string }[] => {
  if (bootstrap.steps?.length) {
    return bootstrap.steps.map((step, index) => ({
      id: step.id ?? STEP_IDS[index] ?? `step${index}`,
      state: (step.state as StepState) ?? "pending",
      detail: step.detail ?? "",
    }));
  }
  const active = stageIndex(bootstrap.stage);
  return STEP_IDS.map((id, index) => ({
    id,
    state: bootstrap.error
      ? index === active
        ? "failed"
        : index < active
          ? "done"
          : "pending"
      : index < active
        ? "done"
        : index === active
          ? "running"
          : "pending",
    detail: index === active ? (bootstrap.installMessage ?? "") : "",
  }));
};

const keepRecent = (text: string, maxLines = 400) => {
  const lines = text.split("\n");
  return lines.length <= maxLines ? text : lines.slice(-maxLines).join("\n");
};

/** Android setup: a real channel choice for a first install, then backend-reported steps. */
export default function AndroidInstallStepper({ text, theme }: { text: string; theme: string }) {
  const { t } = useAppTranslation();
  const [state, setState] = useState<StartupState>({});
  const [failure, setFailure] = useState("");
  const [pendingChannel, setPendingChannel] = useState<Channel | null>(null);
  const [channelBusy, setChannelBusy] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const verified = useWebSocketStore((s) => s._server_verified);
  const phase = useWebSocketStore((s) => s._auth_phase);
  const authError = useWebSocketStore((s) => s._auth_error);
  const uiReady = useWebSocketStore((s) => s._android_ui_ready);
  const initiating = useWebSocketStore((s) => s._initiating);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await invoke<StartupState>("updater_get_startup_state");
        if (disposed) return;
        setState(next);
        setFailure("");
      } catch (error) {
        if (!disposed) setFailure(String(error));
      } finally {
        if (!disposed) timer = setTimeout(poll, 500);
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, []);

  const bootstrap = state.bootstrap ?? {};
  const steps = useMemo(() => normalizeSteps(bootstrap), [bootstrap]);
  const channel = bootstrap.channel ?? state.channel ?? "stable";
  const installed = bootstrap.backendInstalled === true || state.baasRootExistsNonEmpty === true;
  // Offer the choice as soon as the device has neither an install nor a saved
  // channel, so the first paint does not dead-end in "waiting" before the
  // backend process has published its own status.
  const awaitingChannel =
    !bootstrap.error &&
    !installed &&
    (bootstrap.awaitingChannel === true ||
      bootstrap.stage === "channel" ||
      state.channelSelected === false);

  const backendError = bootstrap.error || (bootstrap.stage === "failed" ? state.bootstrap?.traceback : "");
  const clientError = authError;

  const logText = useMemo(() => {
    const parts = [(state.startupLog ?? "").trim(), text.trim()].filter(Boolean);
    return keepRecent(parts.join("\n"));
  }, [state.startupLog, text]);

  const selectChannel = useCallback(async () => {
    if (!pendingChannel || channelBusy) return;
    setChannelBusy(true);
    try {
      await invoke("updater_select_channel", { channel: pendingChannel });
    } catch (error) {
      setFailure(String(error));
    } finally {
      setChannelBusy(false);
    }
  }, [pendingChannel, channelBusy]);

  const retry = useCallback(async () => {
    if (retrying) return;
    setRetrying(true);
    setFailure("");
    try {
      await invoke("updater_restart_backend");
    } catch (error) {
      setFailure(String(error));
    } finally {
      setRetrying(false);
    }
  }, [retrying]);

  const copyLogs = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(logText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }, [logText]);

  const clientSteps = [
    { id: "connect", label: t("androidSetup.clientConnect"), done: verified },
    { id: "auth", label: t("androidSetup.clientAuth"), done: phase === "authenticated" },
    { id: "sync", label: t("androidSetup.clientSync"), done: uiReady },
  ];

  return (
    <main className="fixed inset-0 overflow-y-auto bg-slate-100 px-5 py-6 text-slate-800 dark:bg-slate-950 dark:text-slate-100">
      <header className="mb-5">
        <div className="text-xs font-semibold tracking-widest text-primary-500">
          BAAS / ANDROID
        </div>
        <h1 className="mt-2 text-2xl font-semibold">{t("androidSetup.title")}</h1>
        <p className="mt-2 text-sm text-slate-500">{t("androidSetup.subtitle")}</p>
      </header>

      {awaitingChannel ? (
        <section className="mb-5" aria-labelledby="channel-choice-title">
          <h2 id="channel-choice-title" className="text-base font-semibold">
            {t("androidSetup.channelTitle")}
          </h2>
          <p className="mt-1 text-sm text-slate-500">{t("androidSetup.channelHint")}</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2" role="radiogroup" aria-labelledby="channel-choice-title">
            {(["stable", "dev"] as Channel[]).map((value) => {
              const selected = (pendingChannel ?? channel) === value;
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setPendingChannel(value)}
                  className={`rounded-xl border p-4 text-left transition ${
                    selected
                      ? "border-primary-500 bg-primary-500/10"
                      : "border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium">
                      {value === "stable"
                        ? t("androidSetup.channelStable")
                        : t("androidSetup.channelDev")}
                    </span>
                    {selected && <Check size={18} className="text-primary-500" />}
                  </div>
                  <p className="mt-1 text-xs leading-5 text-slate-500">
                    {value === "stable"
                      ? t("androidSetup.channelStableHint")
                      : t("androidSetup.channelDevHint")}
                  </p>
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => void selectChannel()}
            disabled={channelBusy}
            className="mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary-500 text-sm font-medium text-white disabled:opacity-60"
          >
            {channelBusy && <Loader2 size={16} className="animate-spin" />}
            {channelBusy ? t("androidSetup.waiting") : t("androidSetup.continue")}
          </button>
        </section>
      ) : (
        <section className="mb-5" aria-label={t("androidSetup.progress")}>
          <ol className="space-y-1">
            {steps.map((step, index) => {
              const label = STEP_LABELS[step.id] ?? ("androidSetup.stepService" as TranslationKey);
              const open = expanded === step.id;
              const isLast = index === steps.length - 1;
              return (
                <li key={step.id} className="relative pb-4 pl-10">
                  {!isLast && (
                    <div
                      className={`absolute left-3.5 top-8 bottom-0 w-px ${
                        step.state === "done"
                          ? "bg-primary-500"
                          : "bg-slate-300 dark:bg-slate-700"
                      }`}
                    />
                  )}
                  <span
                    className={`absolute left-0 top-0 flex size-7 items-center justify-center rounded-full text-xs font-semibold ${
                      step.state === "failed"
                        ? "bg-red-500 text-white"
                        : step.state === "done" || step.state === "running"
                          ? "bg-primary-500 text-white"
                          : "bg-slate-200 text-slate-500 dark:bg-slate-800"
                    }`}
                  >
                    {step.state === "failed" ? (
                      <CircleAlert size={16} />
                    ) : step.state === "done" ? (
                      <Check size={16} />
                    ) : step.state === "running" ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      index + 1
                    )}
                  </span>
                  <button
                    type="button"
                    className="flex min-h-7 w-full items-center justify-between gap-2 text-left"
                    onClick={() => setExpanded(open ? null : step.id)}
                    aria-expanded={open}
                    disabled={!step.detail}
                  >
                    <span className="font-medium">{t(i18nKey(label))}</span>
                    <span className="flex items-center gap-1 text-xs text-slate-500">
                      {t(i18nKey(STATE_LABELS[step.state] ?? "androidSetup.statePending"))}
                      {step.detail && <ChevronDown size={14} />}
                    </span>
                  </button>
                  {(open || (step.state === "running" && step.detail)) && step.detail && (
                    <p className="mt-1 break-words text-xs leading-5 text-slate-500">
                      {step.detail}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {!awaitingChannel && (
        <section className="mb-5 rounded-xl border border-slate-300 bg-white p-3 dark:border-slate-700 dark:bg-slate-900">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            {t("androidSetup.clientTitle")}
          </h2>
          <ul className="mt-2 space-y-1 text-sm">
            {clientSteps.map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-2">
                <span>{item.label}</span>
                <span className={item.done ? "text-primary-500" : "text-slate-500"}>
                  {item.done ? <Check size={16} /> : <Loader2 size={14} className="animate-spin" />}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(backendError || clientError || failure) && (
        <div role="alert" className="mb-5 rounded-xl border border-red-400 bg-red-500/10 p-3 text-sm text-red-500">
          <div className="font-medium">{t("androidSetup.errorTitle")}</div>
          <p className="mt-1 break-words whitespace-pre-wrap">{backendError || clientError || failure}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void retry()}
              disabled={retrying}
              className="flex items-center gap-1.5 rounded-lg bg-red-500 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60"
            >
              <RotateCcw size={14} />
              {retrying ? t("androidSetup.waiting") : t("androidSetup.retry")}
            </button>
            <button
              type="button"
              onClick={() => void copyLogs()}
              className="flex items-center gap-1.5 rounded-lg border border-red-400 px-3 py-1.5 text-xs font-medium"
            >
              <Copy size={14} />
              {copied ? t("androidSetup.copied") : t("androidSetup.copyLogs")}
            </button>
          </div>
        </div>
      )}

      <section className="overflow-hidden rounded-xl border border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900">
        <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2 text-xs dark:border-slate-700">
          <TerminalSquare size={14} />
          {t("androidSetup.logs")}
        </div>
        <div className="h-56 p-2">
          <Suspense
            fallback={
              <pre className="h-full overflow-auto whitespace-pre-wrap text-xs">{logText || t("androidSetup.noLogs")}</pre>
            }
          >
            <Terminal text={logText || t("androidSetup.noLogs")} theme={theme} />
          </Suspense>
        </div>
      </section>

      <footer className="mt-4 space-y-1 break-all text-xs leading-5 text-slate-500">
        <div>
          {t("androidSetup.channelLabel")}:{" "}
          {channel === "dev" ? t("androidSetup.channelDev") : t("androidSetup.channelStable")}
          {bootstrap.channelFallback && ` · ${t("androidSetup.channelFallback")}`}
        </div>
        {state.installPath && (
          <div>
            {t("androidSetup.installPath")}: {state.installPath}
          </div>
        )}
        {bootstrap.installMessage && <div>{bootstrap.installMessage}</div>}
        {installed && initiating && <div>{t("androidSetup.syncing")}</div>}
      </footer>
    </main>
  );
}

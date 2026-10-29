import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, CircleAlert, CircleDot, Copy, Loader2, RotateCcw } from "lucide-react";
import { invoke } from "@/shared/TauriInvoke";
import { useAppTranslation } from "@/shared/useAppTranslation";
import { i18nKey } from "@/shared/I18nKeys";
import { observeResizeOnAnimationFrame } from "@/shared/AnimationFrameResizeObserver";
import { copyBrowserText } from "@/shared/BrowserClipboard";
import { useWebSocketStore } from "@/store/WebsocketStore";
import type { TranslationKey } from "@/types/i18n";
import {
  resolveAndroidInstallState,
  androidInstallProgressId,
  androidInstallDisplayState,
  submitAndroidInstallChannel,
  type AndroidBootstrap,
  type AndroidInstallChannel,
  type AndroidStartupState,
} from "@/android/installState";

const Terminal = React.lazy(() => import("@/components/AndroidStartupTerminal"));

type StepState = "pending" | "running" | "done" | "failed";

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
  waiting: "androidSetup.awaitingConfirmation",
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
const normalizeSteps = (
  bootstrap: AndroidBootstrap
): { id: string; state: StepState; detail: string }[] => {
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
export default function AndroidInstallStepper({ text }: { text: string }) {
  const { t } = useAppTranslation();
  const [state, setState] = useState<AndroidStartupState>({});
  const [failure, setFailure] = useState("");
  const [pollFailure, setPollFailure] = useState("");
  const [pendingChannel, setPendingChannel] = useState<AndroidInstallChannel | null>(null);
  const [channelBusy, setChannelBusy] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [copied, setCopied] = useState(false);
  const stepsRef = useRef<HTMLOListElement>(null);

  const verified = useWebSocketStore((s) => s._server_verified);
  const phase = useWebSocketStore((s) => s._auth_phase);
  const authError = useWebSocketStore((s) => s._auth_error);
  const uiReady = useWebSocketStore((s) => s._android_ui_ready);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await invoke<AndroidStartupState>("updater_get_startup_state");
        if (disposed) return;
        setState(next);
        setPollFailure("");
      } catch (error) {
        if (!disposed) setPollFailure(String(error));
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
  const { selectedChannel, awaitingChannel, showChannelChoice, backendError, clientError } =
    resolveAndroidInstallState(state, pendingChannel, authError);
  const activeStepId = androidInstallProgressId(steps, bootstrap.currentStep);

  useEffect(() => {
    const strip = stepsRef.current;
    if (!strip) return;
    const followActiveStep = () => {
      const active = strip.querySelector<HTMLElement>('[aria-current="step"]');
      if (!active) return;
      const stripBounds = strip.getBoundingClientRect();
      const activeBounds = active.getBoundingClientRect();
      if (activeBounds.left >= stripBounds.left && activeBounds.right <= stripBounds.right) return;
      strip.scrollTo({
        left:
          strip.scrollLeft +
          activeBounds.left -
          stripBounds.left -
          (strip.clientWidth - active.clientWidth) / 2,
        behavior: "smooth",
      });
    };
    return observeResizeOnAnimationFrame(strip, followActiveStep);
  }, [activeStepId]);

  const logText = useMemo(() => {
    const parts = [(state.startupLog ?? "").trim(), text.trim()].filter(Boolean);
    return keepRecent(parts.join("\n"));
  }, [state.startupLog, text]);

  const selectChannel = async () => {
    if (channelBusy) return;
    setChannelBusy(true);
    setFailure("");
    try {
      await submitAndroidInstallChannel(invoke, selectedChannel, !!backendError);
    } catch (error) {
      setFailure(String(error));
    } finally {
      setChannelBusy(false);
    }
  };

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
      const success = await copyBrowserText(logText);
      setCopied(success);
      if (success) setTimeout(() => setCopied(false), 1500);
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
    <main
      data-android-setup
      aria-label={t("androidSetup.title")}
      className="fixed inset-0 flex min-h-0 flex-col gap-2 overflow-hidden bg-slate-100 p-3 text-slate-800 dark:bg-slate-950 dark:text-slate-100 sm:p-4 [@media(max-height:400px)]:gap-1.5 [@media(max-height:400px)]:p-2"
    >
      <section className="min-w-0 shrink-0" aria-label={t("androidSetup.progress")}>
        <ol ref={stepsRef} className="relative flex gap-2 overflow-x-auto overflow-y-hidden">
          {steps.map((step, index) => {
            const label = STEP_LABELS[step.id] ?? ("androidSetup.stepService" as TranslationKey);
            const active = activeStepId === step.id;
            const stepState = androidInstallDisplayState(step, awaitingChannel);
            return (
              <li
                key={step.id}
                data-step-state={stepState}
                aria-current={active ? "step" : undefined}
                title={
                  step.detail || t(i18nKey(STATE_LABELS[stepState] ?? "androidSetup.statePending"))
                }
                className={`flex min-w-32 shrink-0 items-center gap-2 rounded-lg border px-2.5 py-2 [@media(max-height:400px)]:py-1 ${
                  stepState === "failed"
                    ? "border-red-400 bg-red-500/10"
                    : active
                      ? "border-primary-500 bg-primary-500/10"
                      : "border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900"
                }`}
              >
                <span
                  className={`flex size-6 shrink-0 items-center justify-center rounded-full text-xs ${
                    stepState === "failed"
                      ? "bg-red-500 text-white"
                      : stepState === "done" || stepState === "running" || stepState === "waiting"
                        ? "bg-primary-500 text-white"
                        : "bg-slate-200 text-slate-500 dark:bg-slate-800"
                  }`}
                >
                  {stepState === "failed" ? (
                    <CircleAlert size={14} />
                  ) : stepState === "done" ? (
                    <Check size={14} />
                  ) : stepState === "running" ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : stepState === "waiting" ? (
                    <CircleDot size={14} />
                  ) : (
                    index + 1
                  )}
                </span>
                <span className="whitespace-nowrap text-xs font-medium">
                  {stepState === "waiting"
                    ? t("androidSetup.awaitingConfirmation")
                    : t(i18nKey(label))}
                </span>
                <span className="sr-only">
                  {t(i18nKey(STATE_LABELS[stepState] ?? "androidSetup.statePending"))}
                </span>
              </li>
            );
          })}
        </ol>
      </section>

      {showChannelChoice && (
        <section
          className="grid shrink-0 grid-cols-2 gap-2 sm:grid-cols-[minmax(0,1fr)_auto]"
          aria-label={t("androidSetup.channelTitle")}
        >
          <div
            className="col-span-2 grid min-w-0 grid-cols-2 gap-2 sm:col-span-1"
            role="radiogroup"
            aria-label={t("androidSetup.channelTitle")}
          >
            {(["stable", "dev"] as AndroidInstallChannel[]).map((value) => {
              const selected = selectedChannel === value;
              const unavailable = value === "stable";
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-disabled={unavailable}
                  disabled={unavailable || channelBusy}
                  title={unavailable ? t("androidSetup.channelUnavailable") : undefined}
                  onClick={() => setPendingChannel(value)}
                  className={`flex h-10 items-center justify-center gap-2 rounded-lg border px-3 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 [@media(max-height:400px)]:h-8 ${
                    selected
                      ? "border-primary-500 bg-primary-500/10"
                      : "border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900"
                  }`}
                >
                  <span>
                    {value === "stable"
                      ? t("androidSetup.channelStable")
                      : t("androidSetup.channelDev")}
                  </span>
                  {selected && <Check size={16} className="shrink-0 text-primary-500" />}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => void selectChannel()}
            disabled={channelBusy}
            className="col-span-2 flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg bg-primary-500 px-3 text-sm font-medium text-white disabled:opacity-60 sm:col-span-1 [@media(max-height:400px)]:h-8"
          >
            {channelBusy && <Loader2 size={16} className="animate-spin" />}
            {channelBusy ? t("androidSetup.waiting") : t("androidSetup.confirmInstall")}
          </button>
        </section>
      )}

      {!showChannelChoice && (
        <section className="min-w-0 shrink-0" aria-label={t("androidSetup.clientTitle")}>
          <ul className="flex gap-3 overflow-x-auto whitespace-nowrap text-xs">
            {clientSteps.map((item) => (
              <li key={item.id} className="flex shrink-0 items-center gap-1.5">
                <span>{item.label}</span>
                <span className={item.done ? "text-primary-500" : "text-slate-500"}>
                  {item.done ? <Check size={16} /> : <Loader2 size={14} className="animate-spin" />}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(backendError || clientError || failure || pollFailure) && (
        <div
          role="alert"
          className="flex min-h-0 max-h-[30%] shrink-0 gap-2 rounded-lg border border-red-400 bg-red-500/10 p-2 text-xs text-red-500 [@media(max-height:400px)]:max-h-12"
        >
          <p
            className="min-h-0 min-w-0 flex-1 overflow-y-auto break-words whitespace-pre-wrap"
            aria-label={t("androidSetup.errorTitle")}
          >
            {backendError || clientError || failure || pollFailure}
          </p>
          <div className="flex shrink-0 flex-col justify-start gap-1.5 [@media(max-height:400px)]:flex-row">
            <button
              type="button"
              onClick={() => void retry()}
              disabled={retrying}
              aria-label={retrying ? t("androidSetup.waiting") : t("androidSetup.retry")}
              title={t("androidSetup.retry")}
              className="flex items-center justify-center gap-1.5 rounded-md bg-red-500 px-2 py-1.5 text-xs font-medium text-white disabled:opacity-60"
            >
              <RotateCcw size={14} />
              <span className="[@media(max-height:400px)]:hidden">
                {retrying ? t("androidSetup.waiting") : t("androidSetup.retry")}
              </span>
            </button>
            <button
              type="button"
              onClick={() => void copyLogs()}
              aria-label={copied ? t("androidSetup.copied") : t("androidSetup.copyLogs")}
              title={copied ? t("androidSetup.copied") : t("androidSetup.copyLogs")}
              className="flex items-center justify-center gap-1.5 rounded-md border border-red-400 px-2 py-1.5 text-xs font-medium"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              <span className="[@media(max-height:400px)]:hidden">
                {copied ? t("androidSetup.copied") : t("androidSetup.copyLogs")}
              </span>
            </button>
          </div>
        </div>
      )}

      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-slate-800 bg-[#0b1220] text-slate-200">
        <div className="flex shrink-0 items-center gap-2 border-b border-slate-800 bg-[#0b1220] px-2.5 py-1.5 text-xs">
          <img src="/images/logo.png" alt="" className="size-3.5 shrink-0 object-contain" />
          <span className="font-semibold tracking-wide">BAAS</span>
          <span className="ml-auto text-slate-400">{t("androidSetup.logs")}</span>
        </div>
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden bg-[#0b1220] p-1.5">
          <Suspense
            fallback={
              <pre className="h-full overflow-auto whitespace-pre-wrap text-xs">
                {logText || t("androidSetup.noLogs")}
              </pre>
            }
          >
            <Terminal text={logText || t("androidSetup.noLogs")} />
          </Suspense>
        </div>
      </section>
    </main>
  );
}

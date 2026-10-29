export type AndroidInstallChannel = "stable" | "dev";

export interface AndroidBootstrapStep {
  id?: string;
  title?: string;
  state?: string;
  detail?: string;
}

export interface AndroidBootstrap {
  stage?: string;
  error?: string;
  traceback?: string;
  installMessage?: string;
  backendInstalled?: boolean;
  steps?: AndroidBootstrapStep[];
  channel?: string;
  awaitingChannel?: boolean;
  currentStep?: string;
  channelFallback?: boolean;
}

export interface AndroidStartupState {
  bootstrap?: AndroidBootstrap;
  startupLog?: string;
  installPath?: string;
  channel?: string;
  channelSelected?: boolean;
  baasRootExistsNonEmpty?: boolean;
}

/** Follow real progress without resetting a user's horizontal scroll on every status poll. */
export function androidInstallProgressId(
  steps: readonly { id: string; state: string }[],
  currentStep?: string
) {
  return (
    steps.find((step) => step.id === currentStep)?.id ??
    steps.find((step) => step.state === "failed")?.id ??
    steps.find((step) => step.state === "running")?.id ??
    steps.filter((step) => step.state === "done").at(-1)?.id ??
    steps[0]?.id
  );
}

/** Waiting for the user is a distinct state from executing backend work. */
export function androidInstallDisplayState(
  step: { id: string; state: string },
  awaitingChannel: boolean
) {
  if (!awaitingChannel || step.state === "failed" || step.state === "done") return step.state;
  if (step.id === "channel") return "waiting";
  return step.state === "running" ? "pending" : step.state;
}

/** A failed install must persist its new channel before scheduling a fresh bootstrap. */
export async function submitAndroidInstallChannel(
  request: (command: string, args?: { channel: AndroidInstallChannel }) => Promise<unknown>,
  channel: AndroidInstallChannel,
  restartFailedInstall: boolean
) {
  await request("updater_select_channel", { channel });
  if (restartFailedInstall) await request("updater_restart_backend");
}

/** Keep the displayed choice, submitted choice and real backend readiness in sync. */
export function resolveAndroidInstallState(
  state: AndroidStartupState,
  pendingChannel: AndroidInstallChannel | null,
  authError: string | null
) {
  const bootstrap = state.bootstrap ?? {};
  const channel: AndroidInstallChannel =
    (bootstrap.channel ?? state.channel) === "stable" ? "stable" : "dev";
  const installed = bootstrap.backendInstalled === true || state.baasRootExistsNonEmpty === true;
  const failedStep = bootstrap.steps?.find((step) => step.state === "failed");
  const backendError =
    bootstrap.error ||
    (bootstrap.stage === "failed" ? bootstrap.traceback : "") ||
    failedStep?.detail;
  const awaitingChannel =
    !backendError &&
    !installed &&
    (bootstrap.awaitingChannel ??
      (bootstrap.stage === "channel" || state.channelSelected === false));
  const serviceStep = bootstrap.steps?.find((step) => step.id === "service");
  // Transport attempts fail normally while installation is still preparing the
  // service. Only surface their errors after the backend confirms it is ready.
  // Older bootstrap versions have no step list, so retain their service stage.
  const serviceReady =
    !awaitingChannel &&
    !backendError &&
    (serviceStep
      ? serviceStep.state === "done"
      : !bootstrap.steps?.length && bootstrap.stage === "service" && installed);

  return {
    channel,
    selectedChannel: installed ? (pendingChannel ?? channel) : "dev",
    installed,
    awaitingChannel,
    showChannelChoice: !installed && (awaitingChannel || !!backendError),
    backendError,
    clientError:
      serviceReady && authError !== "Backend transport startup is cooling down after a failure"
        ? authError
        : null,
  };
}

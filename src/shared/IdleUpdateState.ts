export type IdleScriptStatus = {
  running?: boolean;
  current_task?: string | null;
  waiting_tasks?: string[];
  run_mode?: string | null;
};

export type UpdateResumeState = {
  schema: 1;
  root: string;
  running: Record<string, boolean>;
};

// An absent/partial status is not evidence that a profile is idle.
export function allProfilesIdle(ids: string[], statuses: Record<string, IdleScriptStatus>) {
  return (
    ids.length > 0 &&
    ids.every((id) => {
      const status = statuses[id];
      return (
        status &&
        typeof status.running === "boolean" &&
        status.current_task === null &&
        Array.isArray(status.waiting_tasks) &&
        status.waiting_tasks.length === 0 &&
        !(status.running && status.run_mode === "single")
      );
    })
  );
}

export function captureUpdateResumeState(
  root: string,
  ids: string[],
  statuses: Record<string, IdleScriptStatus>
): UpdateResumeState {
  return {
    schema: 1,
    root,
    running: Object.fromEntries(ids.map((id) => [id, statuses[id].running === true])),
  };
}

export async function restoreUpdateResumeState(
  saved: UpdateResumeState,
  ids: string[],
  command: (name: string, id: string) => Promise<unknown>
) {
  // Apply stopped states too, so startup defaults cannot override the snapshot.
  for (const id of ids) {
    if (Object.hasOwn(saved.running, id)) {
      await command(saved.running[id] ? "start_scheduler" : "stop_scheduler", id);
    }
  }
}

export async function performIdleUpdate(steps: {
  save: () => Promise<void>;
  stop: () => Promise<unknown>;
  update: () => Promise<void>;
  restore: () => Promise<void>;
  clear: () => Promise<void>;
}) {
  // A failed save must leave every script untouched.
  await steps.save();
  try {
    await steps.stop();
    await steps.update();
    // Keep the record until the next startup has successfully restored all profiles.
  } catch (error) {
    await steps.restore();
    await steps.clear();
    throw error;
  }
}

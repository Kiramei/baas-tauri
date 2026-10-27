export interface AndroidShizukuStatus {
  shizukuInstalled: boolean;
  shizukuRunning: boolean;
  shizukuGranted: boolean;
}

export type AndroidStartAccess = "missing" | "stopped" | "permission" | "ready";

/** Installation, a live binder, and permission are independent requirements. */
export const getAndroidStartAccess = (status: AndroidShizukuStatus): AndroidStartAccess => {
  if (!status.shizukuInstalled) return "missing";
  if (!status.shizukuRunning) return "stopped";
  if (!status.shizukuGranted) return "permission";
  return "ready";
};

/** Never reuse preview state to authorize a new start. Stop remains available. */
export const runAndroidStartAction = async ({
  operation = "start",
  readStatus,
  onBlocked,
  action,
}: {
  operation?: "start" | "stop";
  readStatus: () => Promise<AndroidShizukuStatus>;
  onBlocked: (access: Exclude<AndroidStartAccess, "ready">) => void;
  action: () => Promise<boolean | void> | boolean | void;
}): Promise<boolean> => {
  if (operation === "start") {
    const access = getAndroidStartAccess(await readStatus());
    if (access !== "ready") {
      onBlocked(access);
      return false;
    }
  }
  return (await action()) !== false;
};

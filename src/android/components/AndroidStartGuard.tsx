import { useCallback, useEffect, useRef, useState } from "react";
import CButton from "@/components/ui/CButton";
import { Modal } from "@/components/ui/Modal";
import { invoke } from "@/shared/TauriInvoke";
import {
  getAndroidStartAccess,
  runAndroidStartAction,
  type AndroidShizukuStatus,
  type AndroidStartAccess,
} from "@/shared/AndroidStartPrecondition";
import { useAppTranslation } from "@/shared/useAppTranslation";

type GuardState = AndroidStartAccess | "error" | null;
const readStatus = () => invoke<AndroidShizukuStatus>("android_shizuku_status");

/** Both preview and scheduler starts pass through this live, explicit permission gate. */
export const useAndroidStartGuard = (active: boolean) => {
  const { t } = useAppTranslation();
  const [state, setState] = useState<GuardState>(null);
  const [busy, setBusy] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const access = getAndroidStartAccess(await readStatus());
      setState(access);
      return access;
    } catch (error) {
      console.warn("Shizuku status check failed", error);
      setState("error");
      return "error" as const;
    }
  }, []);

  const run = useCallback(
    async (
      action: () => Promise<boolean | void>,
      operation: "start" | "stop" = "start"
    ): Promise<boolean> => {
      if (inFlight.current) return false;
      inFlight.current = true;
      setBusy(true);
      setActionFailed(false);
      try {
        return await runAndroidStartAction({ operation, readStatus, onBlocked: setState, action });
      } catch (error) {
        console.warn("Shizuku startup check failed", error);
        setState("error");
        return false;
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    []
  );

  useEffect(() => {
    if (!active || state === null) return;
    const resume = () => {
      if (!document.hidden) void refresh();
    };
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [active, refresh, state]);

  useEffect(() => {
    if (!active) setState(null);
  }, [active]);

  const perform = async (
    command: "android_open_shizuku" | "android_request_shizuku_permission"
  ) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setActionFailed(false);
    try {
      // The app may have stopped or been removed while this dialog was open.
      const access = getAndroidStartAccess(await readStatus());
      setState(access);
      if (access === "missing" || access === "ready") return;
      if (command === "android_request_shizuku_permission" && access !== "permission") return;
      await invoke(command);
      if (command === "android_request_shizuku_permission") await refresh();
    } catch (error) {
      console.warn("Shizuku setup action failed", error);
      setActionFailed(true);
      await refresh();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const title =
    state === "missing"
      ? t("android.start.missingTitle")
      : state === "stopped"
        ? t("android.start.stoppedTitle")
        : state === "permission"
          ? t("android.start.permissionTitle")
          : state === "ready"
            ? t("android.start.readyTitle")
            : t("android.start.checkFailedTitle");
  const description =
    state === "missing"
      ? t("android.start.missingDescription")
      : state === "stopped"
        ? t("android.start.stoppedDescription")
        : state === "permission"
          ? t("android.start.permissionDescription")
          : state === "ready"
            ? t("android.start.readyDescription")
            : t("android.start.checkFailedDescription");

  return {
    run,
    busy,
    dialog: (
      <Modal isOpen={active && state !== null} onClose={() => setState(null)} title={title}>
        <div>
          <p className="text-sm leading-6 text-muted-foreground">{description}</p>
          {actionFailed && (
            <p role="status" className="mt-3 text-sm leading-6 text-destructive">
              {t("android.start.actionFailed")}
            </p>
          )}
          <div className="modal-footer">
            <CButton variant="secondary" onClick={() => setState(null)}>
              {t("common.close")}
            </CButton>
            {(state === "stopped" || state === "permission") && (
              <CButton
                variant={state === "permission" ? "secondary" : "primary"}
                disabled={busy}
                onClick={() => void perform("android_open_shizuku")}
              >
                {t("android.start.openShizuku")}
              </CButton>
            )}
            {state === "permission" && (
              <CButton
                disabled={busy}
                onClick={() => void perform("android_request_shizuku_permission")}
              >
                {t("android.start.authorize")}
              </CButton>
            )}
            {state === "error" && (
              <CButton disabled={busy} onClick={() => void refresh()}>
                {t("android.start.checkAgain")}
              </CButton>
            )}
          </div>
        </div>
      </Modal>
    ),
  };
};

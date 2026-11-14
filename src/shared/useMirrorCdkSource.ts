import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useAppTranslation } from "./useAppTranslation";
import { invoke } from "./TauriInvoke";
import { saveLocalMirrorCdk, type MirrorCdkConfig } from "./MirrorCdk";

export function useMirrorCdkSource(
  remote: Record<string, unknown>,
  channel: string,
  setSource: (method: string) => void
) {
  const { t } = useAppTranslation();
  const [localConfigured, setConfigured] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [changing, setChanging] = useState(false);
  useEffect(() => {
    if (!__WITH_TAURI__) return;
    let active = true;
    void invoke<{ config: MirrorCdkConfig }>("updater_get_startup_state").then(
      ({ config }) => {
        if (active) setConfigured(config.general?.mirrorc_cdk_configured === true);
      },
      () => {
        if (active) {
          setConfigured(false);
          toast.error(t("mirrorc.cdk.requestFailed"));
        }
      }
    );
    return () => {
      active = false;
    };
  }, [t]);

  const configured = __WITH_TAURI__
    ? localConfigured === true
    : Boolean(remote.mirrorcCdkConfigured ?? remote.mirrorc_cdk_configured);
  const active = configured && channel === "stable";
  const method = active
    ? "mirrorc"
    : String(remote.updateMethod === "mirrorc" ? "github" : (remote.updateMethod ?? "github"));
  const disabled = busy || changing || (__WITH_TAURI__ && localConfigured === null);
  const changeMethod = async (value: string) => {
    if (disabled || value === method) return;
    setChanging(true);
    try {
      if (__WITH_TAURI__ && active && value !== "mirrorc") {
        setConfigured(await saveLocalMirrorCdk(""));
      }
      setSource(value);
    } catch {
      toast.error(t("mirrorc.cdk.requestFailed"));
    } finally {
      setChanging(false);
    }
  };
  const changeKey = async (value: string) => {
    const saved = await saveLocalMirrorCdk(value);
    setConfigured(saved);
    // The local updater uses the credential for the stable package. Keep the
    // configured Git source available for Dev, OCR and later fallback.
    if (!saved && remote.updateMethod === "mirrorc") setSource("github");
  };
  return { configured, active, method, disabled, setBusy, changeMethod, changeKey };
}

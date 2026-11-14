import { invoke } from "@/shared/TauriInvoke";

export interface MirrorCdkConfig {
  general?: { mirrorc_cdk_configured?: boolean };
}

export interface MirrorCdkValidation {
  success: boolean;
  code?: number | null;
  expiresAtIso?: string | null;
}

export function validateLocalMirrorCdk(channel: string, cdk?: string) {
  return invoke<MirrorCdkValidation>("updater_validate_mirrorc_cdk", {
    request: cdk === undefined ? { channel } : { channel, cdk },
  });
}

export async function saveLocalMirrorCdk(cdk: string) {
  const config = await invoke<MirrorCdkConfig>("updater_update_config", {
    request: { mirrorcCdk: cdk },
  });
  const configured = config.general?.mirrorc_cdk_configured;
  if (configured !== Boolean(cdk.trim())) throw new Error("The local CDK change was not confirmed");
  return configured;
}

/** Old backend snapshots carry the value. Retain only its presence in subscribed state. */
export function publicUpdateSettings(settings: Record<string, unknown>) {
  const { mirrorcCdk, mirrorc_cdk, ...visible } = settings;
  if (mirrorcCdk !== undefined || mirrorc_cdk !== undefined) {
    visible.mirrorcCdkConfigured ??=
      visible.mirrorc_cdk_configured ?? Boolean(mirrorcCdk || mirrorc_cdk);
  }
  return visible;
}

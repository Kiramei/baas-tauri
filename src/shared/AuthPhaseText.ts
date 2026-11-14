import type { TranslationKey } from "@/types/i18n";

/** Describes authentication progress without exposing protocol phase names in the UI. */
export function authPhaseText(phase: string, translator: (key: TranslationKey) => string): string {
  switch (phase) {
    case "idle":
      return translator("connection.opening");
    case "control_connecting":
      return translator("connection.connecting");
    case "server_verified":
      return translator("connection.serverVerified");
    case "waiting_password":
      return translator("connection.waitingPassword");
    case "resuming":
      return translator("connection.resuming");
    case "initializing":
      return translator("connection.initializing");
    case "authenticating":
      return translator("connection.authenticating");
    case "authenticated":
      return translator("connection.authenticated");
    case "revoked":
      return translator("connection.reconnecting");
    default:
      return translator("connection.synchronizing");
  }
}

// Desktop and web clients share the exact authenticated protocol with the CLI.
import {
  ControlConnection as SharedControlConnection,
  SecureWebSocket as SharedSecureWebSocket,
  DEFAULT_SERVER_SIGN_PUBLIC_KEY_B64 as SHARED_SERVER_SIGN_PUBLIC_KEY_B64,
  type ControlSessionBundle,
} from "../../packages/baas-client/src/SecureWebSocket";

export * from "../../packages/baas-client/src/SecureWebSocket";

export const DEFAULT_SERVER_SIGN_PUBLIC_KEY_B64 =
  import.meta.env?.VITE_BAAS_SERVER_SIGN_PUBLIC_KEY_B64 || SHARED_SERVER_SIGN_PUBLIC_KEY_B64;

export class ControlConnection extends SharedControlConnection {
  static async open(url: string): Promise<SharedControlConnection> {
    return SharedControlConnection.open(url, DEFAULT_SERVER_SIGN_PUBLIC_KEY_B64);
  }
}

export class SecureWebSocket extends SharedSecureWebSocket {
  constructor(
    url: string,
    name: string,
    session: ControlSessionBundle,
    binaryType: BinaryType | null = null
  ) {
    super(url, name, session, binaryType, DEFAULT_SERVER_SIGN_PUBLIC_KEY_B64);
  }
}

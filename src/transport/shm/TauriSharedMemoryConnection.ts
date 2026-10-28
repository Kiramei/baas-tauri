import { TauriPipeConnection } from "../pipe/TauriPipeConnection";
import type { BackendChannelName } from "../types";

// Both native adapters use the same ordered raw WebView bridge. Only the
// Rust/Python data plane changes; message and remote-display callbacks stay shared.
export class TauriSharedMemoryConnection extends TauriPipeConnection {
  constructor(channel: BackendChannelName, name: string) {
    super(channel, name, "backend_shm");
  }
}

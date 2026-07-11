import { SecureWebSocket } from "@/shared/SecureWebSocket";
import type {
  BackendChannelName,
  BackendChannelOptions,
  BackendConnection,
  BackendControlSessionBundle,
  BackendTransport,
} from "@/transport/types";

export class WebSocketBackendTransport implements BackendTransport {
  constructor(
    private readonly baseUrl: string,
    private readonly session: BackendControlSessionBundle
  ) {}

  async start(): Promise<void> {}

  async close(): Promise<void> {}

  async openChannel(
    channel: BackendChannelName,
    options: BackendChannelOptions = {}
  ): Promise<BackendConnection> {
    const name = options.name ?? channel;
    const wsChannel = channel === "remote" ? "remote" : channel;
    const connection = new SecureWebSocket(
      `${this.baseUrl}/ws/${wsChannel}`,
      name,
      this.session,
      options.binaryType ?? "arraybuffer"
    );
    return connection;
  }
}

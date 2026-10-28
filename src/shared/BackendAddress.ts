export interface BackendAddressOptions {
  activeBase?: string | null;
  configuredBase?: string;
  webui: boolean;
  android: boolean;
  storedAddress?: string | null;
  storedPort?: number | string | null;
  location?: Pick<Location, "protocol" | "host" | "hostname">;
}

/** Browser deployments share the page origin; native clients retain their local endpoint. */
export function resolveBackendAddress(options: BackendAddressOptions): string {
  if (options.activeBase) return options.activeBase;
  if (options.configuredBase) return options.configuredBase.replace(/\/+$/, "");
  const { location } = options;
  const protocol = location?.protocol === "https:" ? "wss:" : "ws:";
  if (options.webui && location?.host) return `${protocol}//${location.host}`;
  if (options.storedAddress && options.storedPort) {
    const address = options.storedAddress;
    const host = address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
    return `ws://${host}:${Number(options.storedPort)}`;
  }
  if (options.android) return "ws://127.0.0.1:8190";
  if (location?.hostname) return `${protocol}//${location.hostname}:8190`;
  return "ws://127.0.0.1:8190";
}

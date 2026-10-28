import { describe, expect, test } from "bun:test";
import { resolveBackendAddress } from "../../src/shared/BackendAddress";

const browser = { webui: true, android: false };
describe("backend deployment address", () => {
  test("WebUI uses the exact page origin, ignoring stale native endpoint preferences", () => {
    expect(
      resolveBackendAddress({
        ...browser,
        storedAddress: "127.0.0.1",
        storedPort: 8190,
        location: { protocol: "http:", host: "docker.local:28191", hostname: "docker.local" },
      })
    ).toBe("ws://docker.local:28191");
    expect(
      resolveBackendAddress({
        ...browser,
        location: { protocol: "https:", host: "baas.example.com", hostname: "baas.example.com" },
      })
    ).toBe("wss://baas.example.com");
    expect(
      resolveBackendAddress({
        ...browser,
        location: { protocol: "https:", host: "[::1]:9443", hostname: "[::1]" },
      })
    ).toBe("wss://[::1]:9443");
  });
  test("an explicit endpoint override and active native transport take precedence", () => {
    expect(resolveBackendAddress({ ...browser, configuredBase: "wss://backend.test/" })).toBe(
      "wss://backend.test"
    );
    expect(
      resolveBackendAddress({
        ...browser,
        activeBase: "ws://127.0.0.1:9000",
        configuredBase: "wss://other.test",
      })
    ).toBe("ws://127.0.0.1:9000");
  });
  test("native clients retain their saved endpoint and Android loopback fallback", () => {
    expect(
      resolveBackendAddress({
        webui: false,
        android: false,
        storedAddress: "192.168.1.2",
        storedPort: "8190",
      })
    ).toBe("ws://192.168.1.2:8190");
    expect(
      resolveBackendAddress({
        webui: false,
        android: false,
        storedAddress: "::1",
        storedPort: 8190,
      })
    ).toBe("ws://[::1]:8190");
    expect(resolveBackendAddress({ webui: false, android: true })).toBe("ws://127.0.0.1:8190");
  });
});

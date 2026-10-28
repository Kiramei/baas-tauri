import { describe, expect, test } from "bun:test";
import { getBackendConnectionStatus } from "../../src/shared/BackendConnectionStatus";

describe("backend connection status shared by the logo and About", () => {
  const authenticated = {
    transportMode: "websocket" as const,
    _auth_phase: "authenticated" as const,
    _heartbeat_time: 100,
    connections: {},
  };

  test("WebSocket health follows the authenticated control heartbeat", () => {
    expect(getBackendConnectionStatus(authenticated)).toBe("connected");
    expect(getBackendConnectionStatus({ ...authenticated, _heartbeat_time: 0 })).toBe("connecting");
  });

  test("a timed-out heartbeat stays unavailable even if recovery is pending or does nothing", () => {
    const timedOutHeartbeat = authenticated._heartbeat_time;
    expect(getBackendConnectionStatus(authenticated, timedOutHeartbeat)).toBe("connecting");
    expect(
      getBackendConnectionStatus(
        { ...authenticated, _heartbeat_time: timedOutHeartbeat + 1 },
        timedOutHeartbeat
      )
    ).toBe("connected");
  });

  test("native transports require both data channels to be open without a heartbeat", () => {
    for (const transportMode of ["pipe", "shm"] as const) {
      const native = { ...authenticated, transportMode, _heartbeat_time: 0 };
      expect(getBackendConnectionStatus(native)).toBe("connecting");
      expect(
        getBackendConnectionStatus({ ...native, connections: { provider: { readyState: 1 } } })
      ).toBe("connecting");
      expect(
        getBackendConnectionStatus({
          ...native,
          connections: { provider: { readyState: 1 }, sync: { readyState: 1 } },
        })
      ).toBe("connected");
      expect(
        getBackendConnectionStatus({
          ...native,
          connections: { provider: { readyState: 1 }, sync: { readyState: 3 } },
        })
      ).toBe("connecting");
    }
  });

  test("authentication phases override any previous heartbeat or open channels", () => {
    for (const _auth_phase of ["idle", "revoked"] as const)
      expect(getBackendConnectionStatus({ ...authenticated, _auth_phase })).toBe("disconnected");
    for (const _auth_phase of ["control_connecting", "waiting_password", "resuming"] as const)
      expect(getBackendConnectionStatus({ ...authenticated, _auth_phase })).toBe("connecting");
  });
});

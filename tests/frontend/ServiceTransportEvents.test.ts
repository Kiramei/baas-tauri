import { describe, expect, test } from "bun:test";
import { transportRecoveryDelay } from "../../src/shared/ServiceTransportEvents";

describe("transportRecoveryDelay", () => {
  test("backs off and caps repeated recovery attempts", () => {
    expect([0, 1, 2, 3, 4, 8].map(transportRecoveryDelay)).toEqual([
      1_000, 2_000, 4_000, 8_000, 15_000, 15_000,
    ]);
  });
});

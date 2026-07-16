import { describe, expect, test } from "bun:test";
import {
  CorrelationIdAllocator,
  MAX_CORRELATION_ID,
} from "../../src/shared/CorrelationIdAllocator";

describe("CorrelationIdAllocator", () => {
  test("stays unique, strictly increasing, and JS-safe under a frozen clock", () => {
    const allocator = new CorrelationIdAllocator(() => 1_784_196_328_000);
    let previous = -1;
    const observed = new Set<number>();

    for (let index = 0; index < 100_000; index += 1) {
      const value = allocator.allocate(() => false);
      expect(Number.isSafeInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(previous);
      observed.add(value);
      previous = value;
    }

    expect(observed.size).toBe(100_000);
  });

  test("remains monotonic when the wall clock moves backwards", () => {
    const clock = [50_000, 49_000, 1, 50_001];
    const allocator = new CorrelationIdAllocator(() => clock.shift()!);

    expect([
      allocator.allocate(() => false),
      allocator.allocate(() => false),
      allocator.allocate(() => false),
      allocator.allocate(() => false),
    ]).toEqual([50_000, 50_001, 50_002, 50_003]);
  });

  test("increments past reserved identifiers and respects a retry minimum", () => {
    const reserved = new Set([1_000, 1_001, 1_003, 2_000, 2_001]);
    const allocator = new CorrelationIdAllocator(() => 1_000);

    expect(allocator.allocate((candidate) => reserved.has(candidate))).toBe(1_002);
    expect(allocator.allocate((candidate) => reserved.has(candidate))).toBe(1_004);
    expect(allocator.allocate((candidate) => reserved.has(candidate), 2_000)).toBe(2_002);
  });

  test("fails closed when no JS-safe identifier remains", () => {
    const allocator = new CorrelationIdAllocator(() => MAX_CORRELATION_ID);
    expect(allocator.allocate(() => false)).toBe(MAX_CORRELATION_ID);
    expect(() => allocator.allocate(() => false)).toThrow("exhausted");

    const reservedMaximum = new CorrelationIdAllocator(() => MAX_CORRELATION_ID);
    expect(() => reservedMaximum.allocate(() => true)).toThrow("exhausted");
    expect(() => new CorrelationIdAllocator(() => Infinity).allocate(() => false)).toThrow(
      "JS-safe"
    );
  });
});

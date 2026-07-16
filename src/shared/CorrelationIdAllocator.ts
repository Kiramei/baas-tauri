export const MAX_CORRELATION_ID = Number.MAX_SAFE_INTEGER;

export type CorrelationClock = () => number;
export type CorrelationReservation = (candidate: number) => boolean;

/**
 * Allocates monotonically increasing protocol correlation identifiers.
 *
 * The allocator owns monotonicity even when the wall clock stalls or moves
 * backwards. Callers supply the current reservation predicate so identifiers
 * retained by callback or retry tables cannot be reused.
 */
export class CorrelationIdAllocator {
  private lastIssued = -1;

  constructor(private readonly now: CorrelationClock = Date.now) {}

  allocate(isReserved: CorrelationReservation, minimum = 0): number {
    const clockValue = this.now();
    if (!Number.isFinite(clockValue) || clockValue < 0 || clockValue > MAX_CORRELATION_ID) {
      throw new RangeError("correlation clock is outside the JS-safe unsigned integer range");
    }
    if (!Number.isSafeInteger(minimum) || minimum < 0 || minimum > MAX_CORRELATION_ID) {
      throw new RangeError("correlation minimum is outside the JS-safe unsigned integer range");
    }

    const wallClockCandidate = Math.floor(clockValue);
    const monotonicCandidate =
      this.lastIssued < MAX_CORRELATION_ID ? this.lastIssued + 1 : Infinity;
    let candidate = Math.max(wallClockCandidate, monotonicCandidate, minimum);

    while (candidate <= MAX_CORRELATION_ID && isReserved(candidate)) {
      candidate += 1;
    }
    if (!Number.isSafeInteger(candidate) || candidate > MAX_CORRELATION_ID) {
      throw new RangeError("correlation identifier space is exhausted");
    }

    this.lastIssued = candidate;
    return candidate;
  }
}

import { useCallback, useSyncExternalStore } from "react";
import { useStdout } from "ink";

const FRAME_MS = 16;

/** One clock for visible terminal effects; the last subscriber stops it completely. */
export class AnimationClock {
  private elapsedMs = 0;
  private startedAt?: number;
  private focused = true;
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setInterval>;

  private startTimer() {
    if (this.startedAt === undefined) this.startedAt = performance.now() - this.elapsedMs;
    this.timer = setInterval(
      () => {
        // Sample elapsed time once for all effects. Delayed ticks catch up rather
        // than slowing the animation down when the event loop is busy.
        this.elapsedMs = performance.now() - this.startedAt!;
        for (const notify of this.listeners) notify();
      },
      this.focused ? FRAME_MS : FRAME_MS * 2
    );
    this.timer.unref?.();
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (!this.timer) this.startTimer();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size && this.timer) {
        clearInterval(this.timer);
        this.timer = undefined;
        // Keep the phase frozen while nothing is visible. Otherwise a label
        // mounted after a long idle would skip its initial reading pause.
        this.startedAt = undefined;
      }
    };
  };

  setFocused(focused: boolean) {
    if (focused === this.focused) return;
    this.focused = focused;
    if (this.timer) {
      clearInterval(this.timer);
      this.startTimer();
    }
  }

  snapshot(intervalMs = FRAME_MS) {
    return Math.floor(this.elapsedMs / Math.max(FRAME_MS, intervalMs));
  }

  timeSnapshot(intervalMs = 50) {
    const interval = Math.max(FRAME_MS, intervalMs);
    // A stable primitive snapshot lets React ignore clock ticks between the
    // requested animation frames. Reading a snapshot never advances time.
    return this.snapshot(interval) * interval;
  }
}

const clock = new AnimationClock();
const still = () => 0;
const noAnimation = () => () => {};

/** Called by the terminal's focus-in/focus-out events. */
export function setAnimationFocused(focused: boolean): void {
  clock.setFocused(focused);
}

/** Effects subscribe locally, so animation never rerenders the whole workbench. */
export function useAnimation(active = true, intervalMs = 50): { time: number; enabled: boolean } {
  const { stdout } = useStdout();
  const enabled =
    active &&
    stdout.isTTY === true &&
    process.env.TERM !== "dumb" &&
    !/^(1|true)$/i.test(process.env.BAAS_REDUCED_MOTION || "");
  const snapshot = useCallback(() => clock.timeSnapshot(intervalMs), [intervalMs]);
  const time = useSyncExternalStore(
    enabled ? clock.subscribe : noAnimation,
    enabled ? snapshot : still,
    still
  );
  return { time, enabled };
}

/** Frame-counter compatibility for discrete effects such as scrolling labels. */
export function useAnimationFrame(active = true, intervalMs = 120): number {
  const { time } = useAnimation(active, intervalMs);
  return Math.floor(time / Math.max(FRAME_MS, intervalMs));
}

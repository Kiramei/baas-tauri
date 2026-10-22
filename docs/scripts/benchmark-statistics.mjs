export function summarize(samples) {
  if (!samples.length || samples.some((sample) => !Number.isFinite(sample) || sample < 0))
    throw new Error("Benchmark samples must be nonempty, finite and nonnegative");
  const sorted = [...samples].sort((left, right) => left - right);
  const quantile = (fraction) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
  return {
    count: samples.length,
    p50Ms: quantile(0.5),
    p95Ms: quantile(0.95),
    minimumMs: sorted[0],
    maximumMs: sorted.at(-1),
    meanMs: samples.reduce((sum, sample) => sum + sample, 0) / samples.length,
    zeroSamples: samples.filter((sample) => sample === 0).length,
  };
}

export const transportOrders = [
  ["websocket", "pipe", "shm"],
  ["pipe", "shm", "websocket"],
  ["shm", "websocket", "pipe"],
  ["shm", "pipe", "websocket"],
  ["pipe", "websocket", "shm"],
  ["websocket", "shm", "pipe"],
];

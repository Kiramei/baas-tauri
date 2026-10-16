import { encodeBinaryRequest } from "../src/transport/pipe/protocol";

// Run with `bun scripts/benchmark-pipe-encoding.ts`. This isolates WebView-side
// request encoding; it does not claim an end-to-end transport speedup.
const iterations = Number(process.env.BAAS_ENCODING_BENCH_ITERATIONS ?? 20);
if (!Number.isInteger(iterations) || iterations < 1) throw new Error("Invalid iteration count");

function measure(operation: () => number) {
  const timings: number[] = [];
  let encodedBytes = 0;
  for (let i = 0; i < iterations + 3; i++) {
    const start = performance.now();
    encodedBytes = operation();
    const elapsed = performance.now() - start;
    if (i >= 3) timings.push(elapsed);
  }
  timings.sort((a, b) => a - b);
  return {
    p50Ms: timings[Math.floor(timings.length / 2)],
    p95Ms: timings[Math.min(timings.length - 1, Math.floor(timings.length * 0.95))],
    encodedBytes,
  };
}

const results = [1024, 65536, 1048576].map((payloadBytes) => {
  const payload = Uint8Array.from({ length: payloadBytes }, (_, i) => i % 256);
  const legacyJson = measure(
    () =>
      JSON.stringify({
        channel: "remote",
        name: "remote-screen",
        payload: Array.from(payload),
      }).length
  );
  const rawInvoke = measure(
    () => encodeBinaryRequest("remote", "remote-screen", payload).byteLength
  );
  return { payloadBytes, iterations, legacyJson, rawInvoke };
});
console.log(JSON.stringify({ runtime: `Bun ${Bun.version}`, results }, null, 2));

// Opt-in only: launched by scripts/backend-smoke.py against its isolated fake worker.
import { BaasClient, type BaasRunStatus } from "../src/index";

if (process.env.BAAS_SMOKE_ISOLATED !== "1")
  throw new Error("Lifecycle probe requires the isolated backend smoke fixture");
const client = new BaasClient({
  ...(process.env.BAAS_SMOKE_PIPE
    ? { pipe: process.env.BAAS_SMOKE_PIPE }
    : { url: process.env.BAAS_SMOKE_URL }),
  key: process.env.BAAS_KEY,
});
const updates: BaasRunStatus[] = [];
client.onStatus((_update, snapshot) => {
  if (snapshot.alpha) updates.push(snapshot.alpha);
});

async function terminal(runId: string): Promise<BaasRunStatus> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const state = (await client.status()).alpha;
    if (state?.run_id === runId && state.running === false && typeof state.exit_code === "number")
      return state;
    await Bun.sleep(10);
  }
  throw new Error("Isolated run did not reach its correlated terminal state");
}

try {
  await client.connect();
  const successful = await client.request("solve", "alpha", { task: "arena" });
  if (typeof successful.run_id !== "string") throw new Error("Accepted run has no identity");
  const busy = await client.request("solve", "alpha", { task: "arena" });
  if (busy.status !== "already-running" || busy.run_id !== successful.run_id)
    throw new Error("Busy run lost existing identity");
  const success = await terminal(successful.run_id);
  if (success.exit_code !== 0) throw new Error("Successful fixture run did not publish exit_code0");
  const failed = await client.request("solve", "alpha", { task: "fixture_failure" });
  const failure = await terminal(failed.run_id);
  if (failure.exit_code !== 1 || failed.run_id === successful.run_id)
    throw new Error("Failed fixture run did not publish a unique run_id and exit_code1");
  const scheduler = await client.request("start_scheduler", "alpha");
  const stopped = await client.request("stop_scheduler", "alpha");
  const stop = await terminal(scheduler.run_id);
  if (stopped.run_id !== scheduler.run_id || stop.exit_code !== 0)
    throw new Error("Stop acknowledgement lost run identity");
  for (const id of [successful.run_id, failed.run_id, scheduler.run_id]) {
    const runUpdates = updates.filter((status) => status.run_id === id);
    if (
      !runUpdates.some((status) => status.running === true) ||
      !runUpdates.some((status) => status.running === false)
    )
      throw new Error("Provider stream omitted a correlated run transition");
  }
  process.stdout.write(
    `${JSON.stringify({ success, failure, stop, provider_updates: updates.length })}\n`
  );
} finally {
  client.close();
}

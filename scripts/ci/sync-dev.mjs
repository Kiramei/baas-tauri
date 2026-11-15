import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function requireSha(value, label) {
  if (typeof value !== "string" || !SHA.test(value)) throw new Error(`Invalid ${label} SHA`);
  return value;
}

export function validateSyncEvent({ eventName, ref, repository, expectedMainSha, event }) {
  if (!REPOSITORY.test(repository ?? "") || event?.repository?.full_name !== repository)
    throw new Error("The event repository does not match the workflow repository");
  if (ref !== "refs/heads/main") throw new Error("Branch synchronization must run from main");
  requireSha(expectedMainSha, "event main");
  if (eventName === "push") {
    if (event.ref !== ref || event.after !== expectedMainSha || event.forced !== false || event.deleted !== false)
      throw new Error("Expected a non-forced main push with complete event metadata");
  } else if (eventName !== "workflow_dispatch" || event.inputs?.operation !== "branches") {
    throw new Error("Expected a main push or an explicit branches operation");
  }
  return { repository, expectedMainSha };
}

function refSha(value, branch) {
  if (value?.ref !== `refs/heads/${branch}` || value.object?.type !== "commit")
    throw new Error(`Invalid ${branch} reference metadata`);
  return requireSha(value.object.sha, branch);
}

function commitMetadata(value, expected) {
  if (value?.sha !== expected || !Array.isArray(value.parents))
    throw new Error("Invalid commit metadata");
  requireSha(value.tree?.sha, "commit tree");
  for (const parent of value.parents) requireSha(parent?.sha, "commit parent");
  return value;
}

export function createGitHubClient({ repository, token, fetchImpl = globalThis.fetch }) {
  if (!REPOSITORY.test(repository ?? "") || typeof token !== "string" || !token.trim())
    throw new Error("A repository and branch-sync App token are required");
  async function request(method, suffix, body) {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}${suffix}`, {
      method,
      signal: AbortSignal.timeout(20_000),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`GitHub ${method} ${suffix} failed (HTTP ${response.status}); no force retry`);
    try { return await response.json(); }
    catch { throw new Error(`GitHub ${method} ${suffix} returned invalid JSON`); }
  }
  return {
    readRef: (branch) => request("GET", `/git/ref/heads/${branch}`),
    readCommit: (sha) => request("GET", `/git/commits/${requireSha(sha, "commit")}`),
    updateDev: (sha) => request("PATCH", "/git/refs/heads/dev", { sha: requireSha(sha, "target"), force: false }),
  };
}

export async function syncDev({ client, expectedMainSha }) {
  requireSha(expectedMainSha, "event main");
  async function tips() {
    const [main, dev] = await Promise.all([client.readRef("main"), client.readRef("dev")]);
    return { main: refSha(main, "main"), dev: refSha(dev, "dev") };
  }
  const before = await tips();
  if (before.main !== expectedMainSha) return { result: "stale", main: before.main, dev: before.dev };
  if (before.main === before.dev) return { result: "equal", ...before };
  const [main, dev] = await Promise.all([client.readCommit(before.main), client.readCommit(before.dev)]);
  commitMetadata(main, before.main);
  commitMetadata(dev, before.dev);
  if (main.parents.length !== 2 || main.parents[0].sha === main.parents[1].sha)
    throw new Error("Main must be a promotion with exactly two distinct parents");
  if (main.parents[1].sha !== before.dev)
    throw new Error("Dev is not the promoted second parent of main; refusing to overwrite branch history");
  if (main.tree.sha !== dev.tree.sha)
    throw new Error("Main and the promoted Dev commit have different trees");
  const fresh = await tips();
  if (fresh.main !== before.main || fresh.dev !== before.dev)
    throw new Error("Main or Dev changed during validation; refusing a concurrent branch update");
  // GitHub checks fast-forward ancestry again atomically. Never retry with force.
  const updated = refSha(await client.updateDev(before.main), "dev");
  if (updated !== before.main) throw new Error("GitHub returned an unexpected Dev SHA after the update");
  return { result: "fast-forwarded", main: before.main, previousDev: before.dev, dev: updated };
}

async function main() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const input = validateSyncEvent({
    eventName: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF,
    repository: process.env.GITHUB_REPOSITORY,
    expectedMainSha: process.env.EXPECTED_MAIN_SHA,
    event,
  });
  const result = await syncDev({ ...input, client: createGitHubClient({ ...input, token: process.env.BRANCH_SYNC_TOKEN }) });
  const message = `Dev synchronization: ${JSON.stringify(result)}`;
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`::error::Dev synchronization failed: ${error.message}`);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Dev synchronization failed: ${error.message}. No force update was attempted.\n`);
    process.exitCode = 1;
  });
}

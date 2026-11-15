import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function workflow(name: string): any {
  return Bun.YAML.parse(
    readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8")
  );
}

const quality = workflow("code-quality");
const baasx = workflow("baasx");
const guard = workflow("main-source-guard");

test("protected PR gates always report and release packaging is opt-in", () => {
  expect(quality.on.pull_request).not.toHaveProperty("branches");
  expect(quality.on.pull_request.types).toContain("ready_for_review");
  expect(quality.on.pull_request).not.toHaveProperty("paths");
  expect(quality.on.push.branches).toEqual(["baasx-dev"]);
  expect(workflow("release-baasx").jobs.build.uses).toBe("./.github/workflows/baasx.yml");
  expect(workflow("release-baasx").jobs.build.with?.target).toBeUndefined();
  expect(baasx.on.workflow_call.inputs.target.default).toBe("all");
  expect(Object.keys(baasx.on).sort()).toEqual(["workflow_call", "workflow_dispatch"]);
  expect(quality.permissions).toEqual({ contents: "read" });
  expect(quality.concurrency["cancel-in-progress"]).toBe(true);
  expect(quality.on.workflow_dispatch.inputs.mode.options).toContain("appimage-package");
  expect(quality.on.workflow_dispatch.inputs.mode.options).toContain("baasx-package");
  for (const alias of ["linux-arm", "linux-armv7l", "linux-armhf"]) {
    expect(quality.on.workflow_dispatch.inputs.target.options).toContain(alias);
    expect(baasx.on.workflow_dispatch.inputs.target.options).toContain(alias);
  }
  const release = workflow("release-baasx");
  expect(release.jobs["npm-auth"].steps.some((step: any) => step.run?.includes("npm-auth.mjs"))).toBe(true);
  expect(release.jobs.build.needs).toContain("npm-auth");
});

test("main source guard uses trusted base workflow without checking out PR code", () => {
  expect(guard.on.pull_request_target.branches).toEqual(["main"]);
  expect(guard.permissions).toEqual({});
  expect(guard.jobs.source.steps.every((step: any) => !step.uses)).toBe(true);
});

test("Dev synchronization reuses main pushes without invoking builds or blocking CNB jobs", () => {
  const source = workflow("source-dispatch");
  expect(Object.keys(source.on).sort()).toEqual(["push", "workflow_dispatch"]);
  expect(source.on.push.branches).toEqual(["main"]);
  expect(source.on.workflow_dispatch.inputs.operation.options).toContain("branches");
  expect(source.permissions).toEqual({ contents: "read" });
  const sync = source.jobs["sync-dev"];
  expect(sync.environment).toBe("branch-sync");
  expect(sync.if).toContain("github.ref == 'refs/heads/main'");
  expect(sync.if).toContain("github.repository == 'Kiramei/baas-tauri'");
  expect(sync.if).toContain("inputs.operation == 'branches'");
  expect(sync.needs).toBeUndefined();
  expect(sync.concurrency["cancel-in-progress"]).toBe(false);
  expect(source.jobs["sync-repository"].needs).toBeUndefined();
  expect(source.jobs["sync-release"].needs).toBeUndefined();
  expect(source.jobs["sync-repository"].if).toBe("${{ github.event_name == 'push' || inputs.operation == 'repository' || inputs.operation == 'all' }}");
  const token = sync.steps.find((step: any) => step.id === "branch-app");
  expect(token.uses).toBe("actions/create-github-app-token@v3.3.0");
  expect(token.with).toEqual({
    "app-id": "${{ secrets.BRANCH_SYNC_APP_ID }}",
    "private-key": "${{ secrets.BRANCH_SYNC_APP_PRIVATE_KEY }}",
    owner: "${{ github.repository_owner }}",
    repositories: "${{ github.event.repository.name }}",
    "permission-contents": "write",
    "permission-workflows": "write",
  });
  expect(sync.steps.at(-1).run).toBe("node scripts/ci/sync-dev.mjs");
  expect(sync.steps.some((step: any) => step.uses?.includes("release") || step.run?.includes("build"))).toBe(false);
});

const bash = Bun.which("bash");
const shellTest = bash ? test : test.skip;
test("both named gates validate the router output and every contributing job", () => {
  for (const [id, name] of [
    ["quality-gate", "Dev quality gate"],
    ["documentation-gate", "Dev documentation gate"],
  ]) {
    const job = quality.jobs[id];
    expect(job.name).toBe(name);
    expect(job.if).toBe("always()");
    expect(job.needs).toContain("changes");
    const step = job.steps.find((step: any) => step.run?.includes("impact.py gate"));
    expect(step.env.NEEDS).toContain("toJSON(needs)");
    expect(step.env.PLAN).toContain("needs.changes.outputs.plan");
  }
  const tasks = Object.keys(quality.jobs).filter((id) => !id.endsWith("-gate"));
  const observed = new Set([
    ...quality.jobs["quality-gate"].needs,
    ...quality.jobs["documentation-gate"].needs,
  ]);
  expect([...observed].sort()).toEqual(tasks.sort());
});

shellTest("main guard accepts only dev from the same repository", () => {
  const script = guard.jobs.source.steps[0].run;
  const run = (source: string, branch: string) =>
    Bun.spawnSync([bash!, "-c", script], {
      env: {
        ...process.env,
        TARGET_REPOSITORY: "owner/project",
        SOURCE_REPOSITORY: source,
        SOURCE_BRANCH: branch,
      },
    }).exitCode;
  expect(run("owner/project", "dev")).toBe(0);
  expect(run("owner/project", "fix/example")).not.toBe(0);
  expect(run("fork/project", "dev")).not.toBe(0);
});

test("publication queues retain pending versions and run side effects only after verified jobs", () => {
  for (const file of ["release-app", "release-baasx", "release-docker"]) {
    expect(workflow(file).concurrency.queue).toBe("max");
    expect(workflow(file).concurrency["cancel-in-progress"]).not.toBe(true);
  }
  expect(workflow("release-app").jobs["release-update"].needs).toContain("update_tag");
  expect(workflow("release-baasx").jobs["notify-qq"].needs.sort()).toEqual([
    "publish-registry",
    "sync-cnb-release",
  ]);
  expect(workflow("release-docker").jobs.mirror.needs).toBe("build-and-push");
});

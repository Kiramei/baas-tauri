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
});

test("main source guard uses trusted base workflow without checking out PR code", () => {
  expect(guard.on.pull_request_target.branches).toEqual(["main"]);
  expect(guard.permissions).toEqual({});
  expect(guard.jobs.source.steps.every((step: any) => !step.uses)).toBe(true);
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

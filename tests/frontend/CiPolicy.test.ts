import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function workflow(name: string): any {
  return Bun.YAML.parse(
    readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8")
  );
}

const quality = workflow("code-quality");
const docs = workflow("docs-validation");
const guard = workflow("main-source-guard");

test("expensive validation runs only for dev PRs or manual dispatch", () => {
  for (const config of [quality, docs]) {
    expect(config.on.pull_request.branches).toEqual(["dev"]);
    expect(config.on).not.toHaveProperty("push");
    expect(config.on).toHaveProperty("workflow_dispatch");
    expect(config.on.pull_request).not.toHaveProperty("paths");
  }
});

test("main source guard uses trusted base workflow without checking out PR code", () => {
  expect(guard.on.pull_request_target.branches).toEqual(["main"]);
  expect(guard.permissions).toEqual({});
  expect(guard.jobs.source.steps.every((step: any) => !step.uses)).toBe(true);
});

const bash = Bun.which("bash");
const shellTest = bash ? test : test.skip;
shellTest(
  "required gates reject failures and accept only valid skipped jobs",
  () => {
    const gate = quality.jobs["quality-gate"].steps[0].run;
    const run = (env: Record<string, string>) =>
      Bun.spawnSync([bash!, "-c", gate], { env: { ...process.env, ...env } }).exitCode;
    const passed = {
      CHANGES: "success",
      CLIENT_CHANGED: "true",
      NATIVE_CHANGED: "true",
      FONTS: "success",
      FRONTEND: "success",
      RUST: "success",
      ANDROID: "success",
    };
    expect(run(passed)).toBe(0);
    for (const name of ["CHANGES", "FONTS", "FRONTEND", "RUST", "ANDROID"])
      expect(run({ ...passed, [name]: "failure" })).not.toBe(0);
    expect(
      run({
        CHANGES: "success",
        CLIENT_CHANGED: "false",
        NATIVE_CHANGED: "false",
        FONTS: "skipped",
        FRONTEND: "skipped",
        RUST: "skipped",
        ANDROID: "skipped",
      })
    ).toBe(0);
    expect(run({ ...passed, RUST: "skipped" })).not.toBe(0);
    const docGate = docs.jobs["documentation-gate"].steps[0].run;
    const runDoc = (env: Record<string, string>) =>
      Bun.spawnSync([bash!, "-c", docGate], { env: { ...process.env, ...env } }).exitCode;
    expect(runDoc({ CHANGES: "success", DOCS_CHANGED: "true", EXPORT: "success" })).toBe(0);
    expect(runDoc({ CHANGES: "success", DOCS_CHANGED: "false", EXPORT: "skipped" })).toBe(0);
    expect(runDoc({ CHANGES: "success", DOCS_CHANGED: "true", EXPORT: "failure" })).not.toBe(0);
  },
  30_000
);

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

import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface Step {
  name?: string;
  id?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}

interface Workflow {
  env: Record<string, string>;
  jobs: Record<string, { if?: string; steps: Step[] }>;
}

const workflow = (name: string) =>
  Bun.YAML.parse(
    fs.readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8")
  ) as Workflow;
const app = workflow("release-app");
const docker = workflow("release-docker");
const step = (document: Workflow, job: string, name: string) => {
  const found = document.jobs[job].steps.find((item) => item.name === name);
  if (!found) throw new Error(`Missing workflow step: ${job}/${name}`);
  return found;
};

/** These workflow gates use the boolean/string subset shared by Actions and JavaScript. */
const evaluate = (expression: string | undefined, ref: string): unknown => {
  if (expression === undefined) return true;
  if (!expression.startsWith("${{") || !expression.endsWith("}}"))
    throw new Error(`Unsupported workflow expression: ${expression}`);
  return new Function(
    "github",
    "startsWith",
    "contains",
    `"use strict"; return (${expression.slice(3, -2).trim()});`
  )(
    { ref, ref_name: ref.replace(/^refs\/(tags|heads)\//, "") },
    (value: string, prefix: string) => value.startsWith(prefix),
    (value: string, part: string) => value.includes(part)
  );
};

test("release gates classify optional-v rc/post tags and keep every major-zero release out of Winget", () => {
  const publish = step(app, "update_tag", "Publish Release");
  const fixed = step(app, "release-update", "Publish fixed WebView2 updater manifest");
  for (const prefix of ["", "v"]) {
    for (const [version, winget, stable] of [
      ["0.0.9", false, true],
      ["0.0.9.rc1", false, false],
      ["0.0.9.post2", false, true],
      ["1.0.0.rc1", false, false],
      ["1.0.0", true, true],
      ["1.0.0.post2", true, true],
    ] as const) {
      const ref = `refs/tags/${prefix}${version}`;
      expect(evaluate(app.jobs["submit-to-winget"].if, ref), ref).toBe(winget);
      expect(evaluate(docker.env.PUBLISH_IMAGE, ref), ref).toBe(true);
      expect(evaluate(docker.env.PUBLISH_LATEST, ref), ref).toBe(stable);
      expect(evaluate(fixed.if, ref), ref).toBe(stable);
      expect(evaluate(publish.env!.MAKE_LATEST, ref), ref).toBe(String(stable));
      expect(evaluate(app.jobs["release-update"].if, ref), ref).toBe(true);
    }
  }
  expect(evaluate(docker.env.PUBLISH_IMAGE, "refs/heads/main")).toBe(true);
  expect(evaluate(docker.env.PUBLISH_LATEST, "refs/heads/main")).toBe(true);
  expect(evaluate(docker.env.PUBLISH_IMAGE, "refs/heads/dev")).toBe(false);
  expect(evaluate(docker.env.PUBLISH_LATEST, "refs/heads/dev")).toBe(false);
});

test("Winget keeps the real release tag separate from the public version", () => {
  const winget = step(app, "submit-to-winget", "Submit to Winget");
  expect(winget.with!["release-tag"]).toBe("${{ github.ref_name }}");
  expect(winget.with!.version).toBe("${{ env.VERSION }}");
});

const shellTest = process.platform === "win32" ? test.skip : test;
shellTest(
  "the Docker version step strips exactly one optional v without changing rc/post suffixes",
  () => {
    const script = step(docker, "build-and-push", "Resolve canonical image version").run!;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "baas-docker-version-"));
    try {
      for (const tag of [
        "0.0.9",
        "v0.0.9",
        "0.0.9.rc1",
        "v0.0.9.rc1",
        "0.0.9.post2",
        "v0.0.9.post2",
      ]) {
        const output = path.join(root, "output");
        fs.writeFileSync(output, "");
        const result = Bun.spawnSync(["bash", "-c", script], {
          env: {
            ...process.env,
            GITHUB_REF: `refs/tags/${tag}`,
            GITHUB_REF_NAME: tag,
            GITHUB_OUTPUT: output,
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
        expect(fs.readFileSync(output, "utf8")).toBe(`version=${tag.replace(/^v/, "")}\n`);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);

shellTest("Docker Hub versions are mirrored without promoting release candidates to latest", () => {
  const script = step(docker, "mirror", "Mirror Docker Hub image to CNB").run!;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baas-docker-mirror-"));
  const executable = path.join(root, "skopeo");
  const output = path.join(root, "calls");
  fs.writeFileSync(executable, '#!/bin/sh\nprintf "%s\\n" "$@" >> "$CAPTURE_PATH"\n', {
    mode: 0o755,
  });
  try {
    for (const [ref, name, latest, expectedTags] of [
      ["refs/tags/v0.0.9.rc1", "v0.0.9.rc1", "false", ["0.0.9.rc1"]],
      ["refs/tags/0.0.9.post1", "0.0.9.post1", "true", ["0.0.9.post1", "latest"]],
      ["refs/heads/main", "main", "true", ["main", "latest"]],
    ] as const) {
      fs.writeFileSync(output, "");
      const result = Bun.spawnSync(["bash", "-c", script], {
        env: {
          ...process.env,
          PATH: `${root}${path.delimiter}${process.env.PATH}`,
          CAPTURE_PATH: output,
          GITHUB_REF: ref,
          GITHUB_REF_NAME: name,
          PUBLISH_LATEST: latest,
          DOCKERHUB_USERNAME: "example",
          DOCKERHUB_TOKEN: "test-token",
          CNB_DOCKER_TOKEN: "test-token",
          CNB_IMAGE_NAME: "docker.cnb.cool/example/baas-webui",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
      const destinations = fs
        .readFileSync(output, "utf8")
        .split("\n")
        .filter((line) => line.startsWith("docker://docker.cnb.cool/"));
      expect(destinations).toEqual(
        expectedTags.map((tag) => `docker://docker.cnb.cool/example/baas-webui:${tag}`)
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const mirrorWorkflow = app as unknown as {
  on: { workflow_dispatch: { inputs: Record<string, { default?: unknown }> } };
  concurrency: { group: string };
  jobs: Record<
    string,
    {
      if?: string;
      needs?: string | string[];
      permissions?: Record<string, string>;
      concurrency?: { group: string; queue: string };
      "continue-on-error"?: boolean;
      steps: (Step & { uses?: string })[];
    }
  >;
};

function releaseJobAllowed(
  condition: string | undefined,
  github: Record<string, unknown>,
  needs: Record<string, { result: string }>,
  inputs: Record<string, unknown> = {},
  cancelled = false
): boolean {
  const expression = (condition?.replace(/^\$\{\{\s*|\s*\}\}$/g, "") || "true")
    .replace(/\bneeds\.([\w-]+)/g, 'needs["$1"]');
  // Actions adds success() unless a status function is explicitly used.
  if (
    !/\b(always|cancelled|failure|success)\(/.test(expression) &&
    (cancelled || Object.values(needs).some(({ result }) => result !== "success"))
  )
    return false;
  return Boolean(
    new Function(
      "github",
      "needs",
      "inputs",
      "always",
      "cancelled",
      "contains",
      "startsWith",
      `"use strict"; return (${expression});`
    )(
      github,
      needs,
      inputs,
      () => true,
      () => cancelled,
      (value: string, part: string) => value.includes(part),
      (value: string, prefix: string) => value.startsWith(prefix)
    )
  );
}

test("manual mirror dispatch skips every build, updater and existing distributor", () => {
  expect(mirrorWorkflow.on.workflow_dispatch.inputs["dry-run"].default).toBe(true);
  for (const dryRun of [true, false]) {
    const results: Record<string, { result: string }> = {};
    for (const [id, job] of Object.entries(mirrorWorkflow.jobs)) {
      const needs = Object.fromEntries([job.needs ?? []].flat().map((key) => [key, results[key]]));
      results[id] = {
        result: releaseJobAllowed(
          job.if,
          { event_name: "workflow_dispatch", repository: "Kiramei/baas-tauri", ref_name: "main" },
          needs,
          { "mirror-tag": "0.0.9.post1", "dry-run": dryRun }
        )
          ? "success"
          : "skipped",
      };
    }
    expect(
      Object.entries(results)
        .filter(([, job]) => job.result === "success")
        .map(([id]) => id)
    ).toEqual(["mirror-to-upstream"]);
  }
});

test("mirroring is isolated from CNB, Winget and QQ and requires successful stable publication", () => {
  const mirror = mirrorWorkflow.jobs["mirror-to-upstream"];
  expect(mirror.needs).toEqual(["release-update"]);
  expect(mirror["continue-on-error"]).toBe(true);
  expect(mirror.permissions).toEqual({ contents: "read" });
  expect(mirror.concurrency).toEqual({ group: "mirror-upstream-release", queue: "max" });
  for (const [event, tag, result, repository, allowed] of [
    ["push", "0.0.10", "success", "Kiramei/baas-tauri", true],
    ["push", "v0.0.10.post1", "success", "Kiramei/baas-tauri", true],
    ["push", "0.0.10.rc1", "success", "Kiramei/baas-tauri", false],
    ["push", "0.0.10", "failure", "Kiramei/baas-tauri", false],
    ["push", "0.0.10", "cancelled", "Kiramei/baas-tauri", false],
    ["push", "0.0.10", "success", "example/fork", false],
  ] as const) {
    expect(
      releaseJobAllowed(
        mirror.if,
        { event_name: event, ref_name: tag, repository },
        { "release-update": { result } }
      )
    ).toBe(allowed);
  }
  expect(
    releaseJobAllowed(
      mirror.if,
      { event_name: "workflow_dispatch", repository: "Kiramei/baas-tauri" },
      { "release-update": { result: "skipped" } },
      {},
      true
    )
  ).toBe(false);
  for (const [id, job] of Object.entries(mirrorWorkflow.jobs)) {
    if (id !== "mirror-to-upstream")
      expect([job.needs ?? []].flat()).not.toContain("mirror-to-upstream");
  }
  expect(
    mirror.steps.some(
      (item) => item.if === "failure()" && item.run?.includes("GITHUB_STEP_SUMMARY")
    )
  ).toBe(true);
  const appToken = mirror.steps.find((item) => item.uses === "actions/create-github-app-token@v2")!;
  expect(appToken.with).toMatchObject({
    owner: "pur1fying",
    repositories: "blue_archive_auto_script",
    "permission-contents": "write",
  });
  const sync = mirror.steps.find(
    (item) => item.uses === "./.github/actions/mirror-upstream-release"
  )!;
  expect(sync.with!["source-token"]).toBe("${{ github.token }}");
  expect(sync.with!["target-token"]).not.toContain("github.token");
});

test("manual backfills do not hold the source release publication queue", () => {
  const group = mirrorWorkflow.concurrency.group.slice(3, -2).trim();
  const resolve = new Function("github", "format", `return (${group});`);
  const format = (pattern: string, value: string) => pattern.replace("{0}", value);
  expect(resolve({ event_name: "push", run_id: "101" }, format)).toBe("release-app-publication");
  expect(resolve({ event_name: "workflow_dispatch", run_id: "102" }, format)).toBe(
    "release-app-mirror-102"
  );
  expect(resolve({ event_name: "workflow_dispatch", run_id: "103" }, format)).toBe(
    "release-app-mirror-103"
  );
});

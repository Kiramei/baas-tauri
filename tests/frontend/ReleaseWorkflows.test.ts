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
      expect(evaluate(docker.env.STABLE_RELEASE, ref), ref).toBe(stable);
      expect(evaluate(docker.env.PUBLISH_IMAGE, ref), ref).toBe(stable);
      expect(evaluate(fixed.if, ref), ref).toBe(stable);
      expect(evaluate(publish.env!.MAKE_LATEST, ref), ref).toBe(String(stable));
      expect(evaluate(app.jobs["release-update"].if, ref), ref).toBe(true);
    }
  }
  expect(evaluate(docker.env.PUBLISH_IMAGE, "refs/heads/main")).toBe(true);
  expect(evaluate(docker.env.STABLE_RELEASE, "refs/heads/main")).toBe(false);
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

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
  jobs: Record<string, {
    if?: string;
    "runs-on"?: string;
    env?: Record<string, string>;
    outputs?: Record<string, string>;
    steps: Step[];
  }>;
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
    "needs",
    "always",
    "cancelled",
    "startsWith",
    "contains",
    `"use strict"; return (${expression.slice(3, -2).trim().replace(/\bneeds\.([\w-]+)/g, 'needs["$1"]')});`
  )(
    { ref, ref_name: ref.replace(/^refs\/(tags|heads)\//, "") },
    Object.fromEntries(["update_tag", "sync-to-cnb-release"].map(id => [id, { result: "success", outputs: { tag: ref.replace(/^refs\/(tags|heads)\//, "") } }])),
    () => true,
    () => false,
    (value: string, prefix: string) => value.startsWith(prefix),
    (value: string, part: string) => value.includes(part)
  );
};

test("release gates classify optional-v rc/post tags and keep every major-zero release out of Winget", () => {
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
      expect(evaluate(fixed.if, ref), ref).toBe(stable);
      expect(evaluate(app.jobs["release-update"].if, ref), ref).toBe(true);
    }
  }
});

test("Winget keeps the real release tag separate from the public version", () => {
  const winget = step(app, "submit-to-winget", "Submit to Winget");
  expect(winget.with!["release-tag"]).toBe("${{ needs.sync-to-cnb-release.outputs.tag }}");
  expect(winget.with!.version).toBe("${{ env.VERSION }}");
});

const shellTest = process.platform === "win32" ? test.skip : test;
shellTest("Docker recovery resolves existing main-ancestor tags and keeps default branch publication", () => {
  const script = step(docker, "prepare", "Resolve and validate image source").run!;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baas-docker-source-"));
  const source = path.join(root, "source");
  fs.mkdirSync(source);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-c", "user.name=Docker Test", "-c", "user.email=docker@example.invalid", ...args], {
      cwd: source,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
    return new TextDecoder().decode(result.stdout).trim();
  };
  try {
    git("init", "--initial-branch=main");
    fs.mkdirSync(path.join(source, "src/shared"), { recursive: true });
    fs.copyFileSync(new URL("../../src/shared/ReleaseVersion.mjs", import.meta.url), path.join(source, "src/shared/ReleaseVersion.mjs"));
    git("add", ".");
    git("commit", "-m", "fixture");
    const sha = git("rev-parse", "HEAD");
    const cases = ["0.0.10", "v0.0.10", "0.0.10.rc1", "v0.0.10.rc1", "0.0.10.post2", "v0.0.10.post2"];
    for (const tag of cases) git("tag", tag);
    git("checkout", "-b", "outside-main");
    git("commit", "--allow-empty", "-m", "not in main");
    git("tag", "9.9.9");
    git("checkout", "main");
    git("commit", "--allow-empty", "-m", "new recovery workflow on main");
    const mainSha = git("rev-parse", "HEAD");
    git("clone", "--bare", source, path.join(root, "remote.git"));
    git("remote", "add", "origin", path.join(root, "remote.git"));
    const run = (ref: string, input = "", event = "workflow_dispatch") => {
      const output = path.join(root, "output");
      fs.writeFileSync(output, "");
      const result = Bun.spawnSync(["bash", "-c", script], {
        cwd: source,
        env: { ...process.env, INPUT_RELEASE_TAG: input, GITHUB_EVENT_NAME: event, GITHUB_REF: ref, GITHUB_REF_NAME: ref.replace(/^refs\/(tags|heads)\//, ""), GITHUB_OUTPUT: output },
        stdout: "pipe",
        stderr: "pipe",
      });
      return { result, output: Object.fromEntries(fs.readFileSync(output, "utf8").trim().split("\n").filter(Boolean).map(line => line.split("="))) };
    };
    for (const tag of cases) {
      for (const [ref, input, event] of [["refs/heads/main", tag, "workflow_dispatch"], [`refs/tags/${tag}`, "", "push"]]) {
        const { result, output } = run(ref, input, event);
        expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
        expect(output).toEqual({ "release-tag": tag, "image-version": tag.replace(/^v/, ""), "source-sha": sha, "source-short-sha": sha.slice(0, 7), "publish-image": "true", "publish-latest": String(!tag.includes(".rc")) });
      }
    }
    for (const [branch, publish] of [["main", "true"], ["dev", "false"]]) {
      const { result, output } = run(`refs/heads/${branch}`);
      expect(result.exitCode).toBe(0);
      expect(output).toEqual({ "release-tag": "", "image-version": "", "source-sha": mainSha, "source-short-sha": mainSha.slice(0, 7), "publish-image": publish, "publish-latest": publish });
    }
    for (const tag of ["baasx-v0.0.10", "refs/tags/0.0.10", "refs/heads/main", "0.0.10-rc1", " 0.0.10", "0.0.10\n", "0.0.10$(touch injected)", "0.0.10;touch injected", "--help", "vv0.0.10", "0.0.42", "9.9.9"]) {
      const { result, output } = run("refs/heads/main", tag);
      expect(result.exitCode, tag).not.toBe(0);
      expect(output).toEqual({});
    }
    expect(fs.existsSync(path.join(source, "injected"))).toBe(false);
    expect(run("refs/heads/dev", "0.0.10").result.exitCode).not.toBe(0);
    expect(run("refs/tags/0.0.10", "0.0.10", "push").result.exitCode).not.toBe(0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Docker recovery pins validated source and runtime for build, version metadata and mirrors", () => {
  const inputs = (docker as unknown as { on: { workflow_dispatch: { inputs: Record<string, { default: string; required: boolean }> } } }).on.workflow_dispatch.inputs;
  expect(inputs["release-tag"]).toMatchObject({ default: "", required: false });
  for (const job of Object.values(docker.jobs)) expect(job["runs-on"]).toBe("ubuntu-24.04");
  for (const job of ["prepare", "build-and-push"]) {
    expect(docker.jobs[job].steps.some(item => item.with?.["node-version"] === "22")).toBe(true);
  }
  expect(step(docker, "prepare", "Checkout validated image source").with!.ref).toBe("${{ steps.source.outputs.source-sha }}");
  expect(step(docker, "prepare", "Check selected release version").run).toBe('node scripts/check-release-version.mjs "$RELEASE_TAG"');
  expect(step(docker, "build-and-push", "Checkout repository").with!.ref).toBe("${{ needs.prepare.outputs.source-sha }}");
  expect(docker.jobs["build-and-push"].env!.PUBLISH_LATEST).toBe("${{ needs.prepare.outputs.publish-latest }}");
  for (const name of ["Extract GitHub Container Registry metadata", "Extract Docker Hub metadata"]) {
    const tags = step(docker, "build-and-push", name).with!.tags;
    expect(tags).toContain("needs.prepare.outputs.release-tag");
    expect(tags).not.toContain("startsWith(github.ref");
  }
  expect(step(docker, "build-and-push", "Extract GitHub Container Registry metadata").with!.labels).toContain("org.opencontainers.image.revision=${{ needs.prepare.outputs.source-sha }}");
  expect(step(docker, "mirror", "Mirror Docker Hub image to CNB").env!.IMAGE_VERSION).toBe("${{ needs.build-and-push.outputs.image-version }}");
});

shellTest("Docker promotion preserves monotonic latest and identifies each failed stage without a pipeline", () => {
  const script = step(docker, "build-and-push", "Avoid promoting an older stable version").run!;
  expect(script).not.toMatch(/\|\s*(?:node|jq)/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baas-docker-promotion-"));
  const calls = path.join(root, "calls");
  const output = path.join(root, "environment");
  const command = (name: string, body: string) => fs.writeFileSync(path.join(root, name), "#!/bin/bash\nset -eu\n" + body + "\n", { mode: 0o755 });
  command("docker", 'printf \'{"org.opencontainers.image.version":"0.0.9.post1"}\\n\'');
  command("gh", 'echo gh >> "$CAPTURE_PATH"\nif [[ "$FAIL_STAGE" == gh ]]; then exit 73; fi\nprintf "%s\\n" "$RELEASES_PAYLOAD"');
  command("jq", 'if [[ "${1:-}" == --arg ]]; then\n  echo jq >> "$CAPTURE_PATH"\n  if [[ "$FAIL_STAGE" == jq ]]; then exit 74; fi\nfi\nexec "$REAL_JQ" "$@"');
  command("node", 'if [[ "${1:-}" != --version ]]; then\n  echo node >> "$CAPTURE_PATH"\n  if [[ "$FAIL_STAGE" == node ]]; then exit 139; fi\n  if [[ "$FAIL_STAGE" == invalid ]]; then printf "true\\nfalse\\n"; exit 0; fi\nfi\nexec "$REAL_NODE" "$@"');
  try {
    for (const [failure, releases, expectedCode, expectedCalls, decision] of [
      ["", [[{ tag_name: "0.0.9.post1" }]], 0, ["gh", "jq", "node"], "true"],
      ["", [[{ tag_name: "0.0.11" }]], 0, ["gh", "jq", "node"], "false"],
      ["gh", [], 73, ["gh"], ""],
      ["jq", [], 74, ["gh", "jq"], ""],
      ["node", [], 139, ["gh", "jq", "node"], ""],
      ["invalid", [], 1, ["gh", "jq", "node"], ""],
    ] as const) {
      fs.writeFileSync(calls, "");
      fs.writeFileSync(output, "");
      const result = Bun.spawnSync(["bash", "-c", script], {
        cwd: new URL("../../", import.meta.url).pathname,
        env: {
          ...process.env,
          PATH: `${root}${path.delimiter}${process.env.PATH}`,
          REAL_NODE: Bun.which("node")!,
          REAL_JQ: Bun.which("jq")!,
          RUNNER_TEMP: root,
          CAPTURE_PATH: calls,
          GITHUB_ENV: output,
          IMAGE_NAME: "ghcr.io/example/baas-webui",
          TAG: "0.0.10",
          FAIL_STAGE: failure,
          RELEASES_PAYLOAD: JSON.stringify(releases),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(expectedCode);
      expect(fs.readFileSync(calls, "utf8").trim().split("\n")).toEqual([...expectedCalls]);
      expect(fs.readFileSync(output, "utf8")).toBe(decision ? `PUBLISH_LATEST=${decision}\n` : "");
      expect(fs.readdirSync(root).filter(name => name.startsWith("docker-promotion."))).toEqual([]);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

shellTest("Docker Hub versions are mirrored without promoting release candidates to latest", () => {
  const script = step(docker, "mirror", "Mirror Docker Hub image to CNB").run!;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baas-docker-mirror-"));
  const executable = path.join(root, "skopeo");
  const output = path.join(root, "calls");
  fs.writeFileSync(executable, '#!/bin/sh\nprintf "%s\\n" "$@" >> "$CAPTURE_PATH"\n', {
    mode: 0o755,
  });
  try {
    for (const [ref, name, latest, expectedTags, releaseTag] of [
      ["refs/tags/v0.0.9.rc1", "v0.0.9.rc1", "false", ["0.0.9.rc1"], "v0.0.9.rc1"],
      ["refs/tags/0.0.9.post1", "0.0.9.post1", "true", ["0.0.9.post1", "latest"], "0.0.9.post1"],
      ["refs/heads/main", "main", "true", ["main", "latest"], ""],
      ["refs/heads/main", "main", "true", ["0.0.10", "latest"], "0.0.10"],
      ["refs/heads/main", "main", "false", ["0.0.10.rc1"], "v0.0.10.rc1"],
    ] as const) {
      fs.writeFileSync(output, "");
      const result = Bun.spawnSync(["bash", "-c", script], {
        env: {
          ...process.env,
          PATH: `${root}${path.delimiter}${process.env.PATH}`,
          CAPTURE_PATH: output,
          GITHUB_REF: ref,
          GITHUB_REF_NAME: name,
          RELEASE_TAG: releaseTag,
          IMAGE_VERSION: releaseTag.replace(/^v/, ""),
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
  needs: Record<string, { result: string; outputs?: Record<string, string> }>,
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

test("publication recovery requires an explicit main write request and resumes only successful publication", () => {
  expect(mirrorWorkflow.on.workflow_dispatch.inputs["publish-existing"].default).toBe(false);
  const simulate = (tag: string, publish = true, dryRun = false, ref = "refs/heads/main", failed = "") => {
    const results: Record<string, { result: string; outputs: Record<string, string> }> = {};
    for (const [id, job] of Object.entries(mirrorWorkflow.jobs)) {
      const needs = Object.fromEntries([job.needs ?? []].flat().map(key => [key, results[key]]));
      const allowed = releaseJobAllowed(job.if, { event_name: "workflow_dispatch", repository: "Kiramei/baas-tauri", ref, ref_name: ref.split("/").pop() }, needs, { "mirror-tag": tag, "publish-existing": publish, "dry-run": dryRun });
      results[id] = { result: allowed ? (id === failed ? "failure" : "success") : "skipped", outputs: { tag, "source-sha": "a".repeat(40) } };
    }
    return results;
  };
  const success = simulate("0.0.10");
  for (const id of ["check_tag_version", "create_release", "generate_fonts", "release", "release-for-linux-arm", "release-android", "release-for-fixed-webview2"]) expect(success[id].result).toBe("skipped");
  for (const id of ["update_tag", "release-update", "sync-to-cnb-release", "mirrorchyan-uploading", "mirrorchyan-release-note", "notify-qq"]) expect(success[id].result, id).toBe("success");
  expect(success["submit-to-winget"].result).toBe("skipped");
  expect(simulate("1.0.0")["submit-to-winget"].result).toBe("success");
  const rc = simulate("v0.0.10.rc1");
  expect(rc.update_tag.result).toBe("success");
  expect(rc["release-update"].result).toBe("success");
  for (const id of ["sync-to-cnb-release", "submit-to-winget", "notify-qq", "mirror-to-upstream"]) expect(rc[id].result).toBe("skipped");
  for (const results of [simulate("0.0.10", true, true), simulate("0.0.10", true, false, "refs/heads/dev"), simulate("0.0.10", true, false, "refs/heads/main", "update_tag")]) {
    for (const id of ["release-update", "sync-to-cnb-release", "mirrorchyan-uploading", "mirrorchyan-release-note", "notify-qq", "mirror-to-upstream"]) expect(results[id].result, id).toBe("skipped");
  }
  const builds = ["release", "release-for-linux-arm", "release-android", "release-for-fixed-webview2"];
  const automatic = (failed: string, result: string) => releaseJobAllowed(mirrorWorkflow.jobs.update_tag.if, { event_name: "push", ref: "refs/tags/0.0.10" }, Object.fromEntries(builds.map(id => [id, { result: id === failed ? result : "success" }])));
  expect(automatic("", "success")).toBe(true);
  for (const id of builds) for (const result of ["failure", "skipped", "cancelled"]) expect(automatic(id, result)).toBe(false);
});

test("publication and distributors use trusted tooling with explicit selected source tags", () => {
  const update = app.jobs.update_tag;
  expect(update["runs-on"]).toBe("ubuntu-24.04");
  expect(step(app, "update_tag", "Set up Node for release publication").with!["node-version"]).toBe("22");
  const source = step(app, "update_tag", "Resolve verified publication source").run!;
  expect(source).toContain("parseAppReleaseTag(tag)");
  expect(source).toContain("'merge-base', '--is-ancestor'");
  expect(source).toContain("checkReleaseVersion(source, tag)");
  expect(source).toContain("'worktree', 'add', '--detach'");
  expect(step(app, "update_tag", "Fetch UPDATE logs").run).toContain('GITHUB_REF_NAME="$RELEASE_TAG"');
  expect(step(app, "update_tag", "Publish Release").run).not.toContain("|");
  expect(step(app, "update_tag", "Publish Release").run).toContain("scripts/release-publication.mjs");
  expect(step(app, "release-update", "Checkout repository").with!.ref).toBe("${{ github.workflow_sha }}");
  expect(step(app, "sync-to-cnb-release", "Determine CNB Latest from published app versions").run).not.toMatch(/\|\s*node/);
  expect(step(app, "sync-to-cnb-release", "Sync CNB release").with!["tag-name"]).toBe("${{ needs.release-update.outputs.tag }}");
  const qq = app.jobs["notify-qq"].steps;
  expect(qq[0].with!.ref).toBe("${{ github.workflow_sha }}");
  expect(qq[1].with!["tag-name"]).toBe("${{ needs.sync-to-cnb-release.outputs.tag }}");
  const notification = Bun.YAML.parse(fs.readFileSync(new URL("../../.github/actions/notify-qq/action.yml", import.meta.url), "utf8"));
  expect(notification.inputs["tag-name"].default).toBe("${{ github.ref_name }}");
  expect(notification.runs.steps[0].env.RELEASE_TAG).toBe("${{ inputs.tag-name }}");
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
        { "release-update": { result, outputs: { tag } } }
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
  const resolve = new Function("github", "format", "inputs", `return (${group});`);
  const format = (pattern: string, value: string) => pattern.replace("{0}", value);
  expect(resolve({ event_name: "push", run_id: "101" }, format, {})).toBe("release-app-publication");
  expect(resolve({ event_name: "workflow_dispatch", run_id: "102" }, format, {})).toBe(
    "release-app-mirror-102"
  );
  expect(resolve({ event_name: "workflow_dispatch", run_id: "103" }, format, {})).toBe(
    "release-app-mirror-103"
  );
  expect(resolve({ event_name: "workflow_dispatch", run_id: "104" }, format, { "publish-existing": true })).toBe("release-app-publication");
});

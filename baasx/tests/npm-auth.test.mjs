import { YAML } from "bun";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { checkNpmAuth, npmPackages } from "../scripts/npm-auth.mjs";

const environment = {
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://actions.example.invalid/token?existing=value",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "secret-actions-request",
};
const identity = { value: "secret-oidc-jwt" };
const grant = { token_type: "oidc", token: "secret-npm-exchange" };
const response = (status, data) => ({ status, json: async () => data });

test("checks precisely the eight scoped packages using fresh GitHub tokens and empty-body npm exchanges", async () => {
  const names = ["@kiramei/baasx", "@kiramei/baasx-linux-x64", "@kiramei/baasx-linux-arm64", "@kiramei/baasx-linux-arm", "@kiramei/baasx-darwin-arm64", "@kiramei/baasx-darwin-x64", "@kiramei/baasx-win32-x64", "@kiramei/baasx-win32-arm64"];
  expect(npmPackages).toEqual(names);
  const calls = [], logs = [];
  await checkNpmAuth({ environment, log: line => logs.push(line), request: async (url, options) => {
    calls.push({ url, options });
    expect(options.redirect).toBe("error");
    expect(options.body).toBeUndefined();
    if (options.method === "GET") {
      expect(url.hostname).toBe("actions.example.invalid");
      expect(url.searchParams.get("audience")).toBe("npm:registry.npmjs.org");
      expect(options.headers.Authorization).toBe(`Bearer ${environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`);
      return response(200, identity);
    }
    expect(options.method).toBe("POST");
    expect(url.origin).toBe("https://registry.npmjs.org");
    expect(options.headers.Authorization).toBe(`Bearer ${identity.value}`);
    return response(201, grant);
  } });
  expect(calls).toHaveLength(16);
  expect(calls.filter(({ options }) => options.method === "POST").map(({ url }) => decodeURIComponent(url.pathname.split("/").at(-1)))).toEqual(names);
  expect(logs).toHaveLength(8);
  expect(logs.every(line => line.endsWith("OIDC exchange accepted"))).toBe(true);
  expect(logs.join("\n")).not.toContain("secret-");
});

test("registry refusals fail every package without retries, logging response bodies or publishing", async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    let exchanges = 0;
    const logs = [];
    await expect(checkNpmAuth({ environment, log: line => logs.push(line), request: async (_url, { method }) => {
      if (method === "GET") return response(200, identity);
      exchanges++;
      return { status, json: async () => { throw new Error("secret-error-body must not be read"); } };
    } })).rejects.toThrow("preflight failed");
    expect(exchanges).toBe(8);
    expect(logs.every(line => line.includes(`HTTP ${status}`))).toBe(true);
    expect(logs.join("\n")).not.toContain("secret-");
  }
});

test("network errors, malformed credentials and malformed JSON fail without exposing secrets", async () => {
  for (const registryResponse of [
    () => { throw new Error("secret-fetch-error"); },
    () => ({ status: 201, json: async () => { throw new Error("secret-json-body"); } }),
    () => response(201, { ...grant, token: "" }),
    () => response(201, { ...grant, token_type: "unexpected-secret-type" }),
  ]) {
    const logs = [];
    await expect(checkNpmAuth({ environment, log: line => logs.push(line), request: async (_url, { method }) => method === "GET" ? response(200, identity) : registryResponse() })).rejects.toThrow();
    expect(logs.join("\n")).not.toContain("secret");
  }
  let requests = 0;
  await expect(checkNpmAuth({ environment, log: () => {}, request: async () => {
    requests++;
    return response(200, { value: "" });
  } })).rejects.toThrow();
  expect(requests).toBe(8);
});

test("existing token configuration skips OIDC without claiming publish permission; absent credentials fail closed", async () => {
  const logs = [];
  await checkNpmAuth({ environment: { NODE_AUTH_TOKEN: "secret-existing-token" }, log: line => logs.push(line), request: () => { throw new Error("must not request"); } });
  expect(logs.join("\n")).toContain("Publish authorization remains unchecked");
  expect(logs.join("\n")).not.toContain("secret");
  await expect(checkNpmAuth({ environment: {}, request: () => { throw new Error("must not request"); } })).rejects.toThrow("id-token: write");
});

test("auth-only dispatch skips the whole release chain and failed authentication prevents all builds", () => {
  const workflow = YAML.parse(readFileSync(new URL("../../.github/workflows/release-baasx.yml", import.meta.url), "utf8"));
  expect(workflow.on.workflow_dispatch.inputs.auth_only).toMatchObject({ type: "boolean", default: false });
  expect(workflow.jobs["npm-auth"].permissions).toEqual({ contents: "read", "id-token": "write" });
  expect(workflow.jobs.build.needs).toEqual(["validate", "npm-auth"]);
  const simulate = (authOnly, authResult = "success") => {
    const results = {};
    for (const [id, job] of Object.entries(workflow.jobs)) {
      const needs = Object.fromEntries([job.needs ?? []].flat().map(key => [key, results[key]]));
      const expression = (job.if?.replace(/^\$\{\{\s*|\s*\}\}$/g, "") || "true").replace(/\bneeds\.([\w-]+)/g, 'needs["$1"]');
      const dependenciesPassed = /\balways\(/.test(expression) || Object.values(needs).every(({ result }) => result === "success");
      const allowed = dependenciesPassed && new Function("inputs", "github", "needs", "always", `return (${expression})`)({ auth_only: authOnly }, { repository: "Kiramei/baas-tauri" }, needs, () => true);
      results[id] = { result: allowed ? (id === "npm-auth" ? authResult : "success") : "skipped" };
    }
    return Object.entries(results).filter(([, { result }]) => result !== "skipped").map(([id]) => id);
  };
  expect(simulate(true)).toEqual(["npm-auth"]);
  expect(simulate(false, "failure")).toEqual(["npm-auth", "validate"]);
  expect(simulate(false)).toContain("notify-qq");
});

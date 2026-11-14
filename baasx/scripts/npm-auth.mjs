import { URL } from "node:url";
import { platforms } from "./distribution-platforms.mjs";

export const npmPackages = ["@kiramei/baasx", ...platforms.map(({ name }) => name)];

// Only exchange credentials: this does not check direct-publish permission or publish a version.
export async function checkNpmAuth({ environment = process.env, request = globalThis.fetch, log = console.log } = {}) {
  if (environment.NODE_AUTH_TOKEN) {
    log("npm token configured; OIDC preflight skipped. Publish authorization remains unchecked.");
    return;
  }
  if (!environment.ACTIONS_ID_TOKEN_REQUEST_URL || !environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    throw new Error("GitHub OIDC request credentials unavailable; require id-token: write.");
  }
  let oidcUrl;
  try {
    oidcUrl = new URL(environment.ACTIONS_ID_TOKEN_REQUEST_URL);
    oidcUrl.searchParams.set("audience", "npm:registry.npmjs.org");
  } catch {
    throw new Error("Invalid GitHub OIDC request URL.");
  }
  const json = async (url, method, token, expectedStatus) => {
    let response;
    try {
      response = await request(url, {
        method,
        headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
        redirect: "error",
        signal: globalThis.AbortSignal.timeout(20_000),
      });
    } catch {
      return { failure: "network request failed" };
    }
    if (response.status !== expectedStatus) return { failure: `HTTP ${response.status}` };
    try {
      return { data: await response.json() };
    } catch {
      return { failure: "invalid JSON response" };
    }
  };
  let failed = false;
  for (const name of npmPackages) {
    // Get a fresh ID token for each package, matching npm CLI's per-package flow.
    const identity = await json(oidcUrl, "GET", environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN, 200);
    let failure = identity.failure;
    if (!failure && (typeof identity.data?.value !== "string" || !identity.data.value)) failure = "missing GitHub ID token";
    if (!failure) {
      const url = new URL(`/-/npm/v1/oidc/token/exchange/package/${encodeURIComponent(name)}`, "https://registry.npmjs.org");
      const grant = await json(url, "POST", identity.data.value, 201);
      failure = grant.failure;
      if (!failure && (grant.data?.token_type !== "oidc" || typeof grant.data?.token !== "string" || !grant.data.token)) failure = "invalid npm token response";
      // Credentials remain in this process only; never log response bodies or save tokens.
    }
    log(`${name}: ${failure ? `OIDC exchange failed (${failure})` : "OIDC exchange accepted"}`);
    failed ||= Boolean(failure);
  }
  if (failed) throw new Error("npm OIDC exchange preflight failed.");
}

if (import.meta.main) {
  checkNpmAuth().catch(() => {
    console.error("npm authentication preflight failed; no package was published.");
    process.exitCode = 1;
  });
}

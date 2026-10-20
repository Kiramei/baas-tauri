import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const [sourceRepo, snapshot, python] = process.argv.slice(2);
assert.ok(sourceRepo && snapshot && python, "Pass the backend Git repository, disposable source snapshot and Python interpreter");
assert.ok(path.resolve(snapshot).startsWith(path.join(root, ".cache") + path.sep));
const cache = path.join(root, ".cache/service-protocol");
mkdirSync(cache, { recursive: true });
const backendRevision = "d0a86a089068766ff53682b501b90bee99857a71";
const clientRevision = "be186c524ab9f7a91c41582aec3a5fef06614751";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const lf = (value) => value.toString("utf8").replaceAll("\r\n", "\n");
const gitFile = (repo, rev, file) => execFileSync("git", ["-C", repo, "show", rev + ":" + file], { windowsHide: true, timeout: 15000 });
const clientFiles = ["src/shared/SecureWebSocket.ts", "src/transport/factory.ts", "src/transport/pipe/protocol.ts", "src/store/WebsocketStore.ts"];
const clientSources = clientFiles.map((file) => {
  const data = lf(readFileSync(path.join(root, file)));
  assert.equal(data, lf(gitFile(root, clientRevision, file)), "Client source drift: " + file);
  return { file, sha256: sha(data), gitContentVerified: true };
});
const bundle = path.join(cache, "client.js");
const bunVersion = execFileSync("bun", ["--version"], { encoding: "utf8", windowsHide: true, timeout: 15000 }).trim();
execFileSync("bun", ["build", path.join(root, "src/shared/SecureWebSocket.ts"), "--target=browser", "--define",
  'import.meta.env.VITE_BAAS_SERVER_SIGN_PUBLIC_KEY_B64=""', "--outfile", bundle], { windowsHide: true, timeout: 30000, stdio: "pipe" });
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("BAAS_") && !["PYTHONPATH", "PYTHONHOME"].includes(key)));
environment.PYTHONUNBUFFERED = "1";
const child = spawn(python, [path.join(root, "docs/scripts/protocol-fixture.py"), path.resolve(snapshot), bundle, cache], {
  cwd: cache, env: environment, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
});
const exited = new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
const stderrChunks = [];
child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
const stopFixture = async () => {
  if (child.exitCode !== null) return exited;
  child.stdin.end("stop\n");
  const forced = setTimeout(() => {
    if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else child.kill("SIGKILL");
  }, 15000);
  try { return await exited; } finally { clearTimeout(forced); }
};
let browser;
try {
  const lines = createInterface({ input: child.stdout });
  const deadline = setTimeout(() => { child.stdin.end("stop\n"); lines.close(); }, 30000);
  let ready;
  try {
    for await (const line of lines) { ready = JSON.parse(line); break; }
    assert.ok(ready, "The isolated server exited before startup metadata");
  } finally { clearTimeout(deadline); lines.close(); }
  assert.ok(Number.isInteger(ready.port) && ready.port > 0);
  assert.match(ready.temporaryDirectory, /^service-protocol-[a-z0-9_]+$/);
  const backendSources = Object.entries(ready.sources).map(([file, expected]) => {
    assert.match(file, /^[a-zA-Z0-9_./-]+\.py$/);
    const blob = lf(gitFile(sourceRepo, backendRevision, file));
    assert.equal(sha(blob), expected, "Imported backend source differs from Git: " + file);
    assert.equal(lf(readFileSync(path.join(snapshot, file))), blob);
    return { file, sha256: expected, gitContentVerified: true };
  });
  for (const file of ["main.service.py", "cli.example.py", "pyproject.toml", "service/app.py", "service/transport/framing.py", "service/transport/pipe_server.py", "service/transport/shm_server.py", "service/channels/trigger.py", "service/channels/remote.py"]) {
    if (backendSources.some((source) => source.file === file)) continue;
    const blob = lf(gitFile(sourceRepo, backendRevision, file));
    assert.equal(lf(readFileSync(path.join(snapshot, file))), blob);
    backendSources.push({ file, sha256: sha(blob), gitContentVerified: true });
  }
  console.log("Protocol fixture ready; source hashes verified.");
  const base = `http://127.0.0.1:${ready.port}`;
  for (let attempt = 0; ; attempt++) {
    try { assert.equal((await fetch(base + "/health", { signal: AbortSignal.timeout(1000) })).status, 200); break; }
    catch (error) { if (attempt === 30) throw error; await sleep(100); }
  }
  const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
  browser = await chromium.launch({ channel: "msedge", headless: true, timeout: 15000 });
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.name));
  page.on("console", (message) => { if (/^\[protocol-case\] [a-z0-9-]+$/.test(message.text())) console.log(message.text()); });
  await page.goto(base);
  console.log("Browser connected to the isolated fixture.");
  const results = await Promise.race([page.evaluate(async () => {
    const { ControlConnection, SecureWebSocket, rememberControlSession } = await import("/probe.js");
    const ws = location.origin.replace("http:", "ws:");
    const results = [];
    const sockets = [];
    const record = (id, condition) => {
      if (!condition) throw new Error("Protocol assertion: " + id);
      results.push({ id, passed: true });
      console.info("[protocol-case] " + id);
    };
    const until = async (predicate, id) => {
      const start = Date.now();
      while (!predicate()) {
        if (Date.now() - start > 10000) throw new Error("Protocol wait: " + id);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    const control = async () => {
      const connection = await ControlConnection.open(ws + "/ws/control");
      sockets.push(connection);
      return connection;
    };
    const business = async (name, session) => {
      const messages = [];
      const connection = new SecureWebSocket(ws + "/ws/" + name, name, session, "arraybuffer");
      sockets.push(connection);
      await connection.connect((message) => messages.push(message));
      return { connection, messages };
    };
    const rejects = async (operation) => {
      try { await operation(); return false; } catch { return true; }
    };
    const password = crypto.randomUUID() + crypto.randomUUID();
    const replacement = crypto.randomUUID() + crypto.randomUUID();
    try {
      const first = await control();
      record("uninitialized-server", !first.initialized);
      record("missing-cookie-falls-back", await first.resumeWithCookie() === null);
      const session = await first.authenticate(password);
      record("initialize-with-real-argon2", session.authMode === "password" && session.pwdEpoch === 1 && session.masterSecret.length === 32);
      const notices = [];
      first.onSecureMessage = (message) => notices.push(message.type);

      const provider = await business("provider", session);
      await until(() => provider.messages.some((message) => message.type === "logs_full") && provider.messages.some((message) => message.status?.is_all_data_initialized), "provider-snapshot");
      record("provider-secretstream-initial-data", provider.messages.some((message) => message.type === "logs_full"));
      const sync = await business("sync", session);
      sync.connection.sendJson({ type: "pull", resource: "config", resource_id: "fixture" });
      await until(() => sync.messages.some((message) => message.type === "snapshot"), "sync-pull");
      const snapshot = sync.messages.find((message) => message.type === "snapshot");
      record("sync-encrypted-pull", snapshot.data.value === 1 && snapshot.resource_id === "fixture");
      await new Promise((resolve) => setTimeout(resolve, 20));
      sync.connection.sendJson({ type: "patch", resource: "config", resource_id: "fixture", timestamp: snapshot.timestamp, ops: [{ op: "replace", path: "/value", value: 2 }] });
      await until(() => sync.messages.some((message) => message.type === "patch_ack") && sync.messages.some((message) => message.type === "patch"), "sync-ack-and-push");
      const ack = sync.messages.find((message) => message.type === "patch_ack");
      const push = sync.messages.find((message) => message.type === "patch");
      record("patch-ack-echoes-request-time", ack.timestamp === snapshot.timestamp);
      record("patch-push-has-new-snapshot-time", push.timestamp > snapshot.timestamp && push.direction === "push" && push.origin === "frontend");
      sync.connection.sendJson({ type: "patch", resource: "config", resource_id: "fixture", timestamp: snapshot.timestamp, ops: [{ op: "replace", path: "/value", value: 3 }] });
      await until(() => sync.messages.some((message) => message.type === "patch_conflict"), "stale-conflict");
      const conflict = sync.messages.find((message) => message.type === "patch_conflict");
      record("stale-patch-rejected", conflict.data.value === 2 && conflict.request_timestamp === snapshot.timestamp);

      const bad = await control();
      record("wrong-password-rejected", await rejects(() => bad.authenticate(password + "wrong")));
      const ordinary = await control();
      const loggedIn = await ordinary.authenticate(password);
      record("normal-password-login", ordinary.initialized && loggedIn.pwdEpoch === 1 && loggedIn.authMode === "password");
      await rememberControlSession(location.origin, session);
      const remembered = await control();
      const resumed = await remembered.resumeWithCookie();
      record("cookie-control-resume", resumed?.authMode === "remember" && resumed.sessionId !== session.sessionId);
      record("cookie-resume-uses-fresh-secrets", resumed && resumed.masterSecret.some((value, index) => value !== session.masterSecret[index]));
      const response = await fetch("/auth/logout", { method: "POST", credentials: "include" });
      record("logout-http-success", response.ok);
      const afterLogout = await control();
      record("logout-cookie-removed", await afterLogout.resumeWithCookie() === null);
      afterLogout.close();
      const beforeLogoutStatus = provider.messages.length;
      provider.connection.sendJson({ type: "status_request" });
      await until(() => provider.messages.length > beforeLogoutStatus, "active-session-after-logout");
      record("logout-does-not-revoke-active-session", provider.messages.at(-1).type === "status");

      // Invoke the production cipher used by the control protocol, not a copied implementation.
      remembered.ws.send(JSON.stringify(remembered.controlChannel.encrypt({ type: "change_password", new_password: replacement })));
      await until(() => notices.includes("auth_revoked"), "password-revocation");
      record("password-change-notifies-control", notices.includes("auth_revoked"));
      const beforeRevokedStatus = provider.messages.length;
      provider.connection.sendJson({ type: "status_request" });
      await until(() => provider.messages.length > beforeRevokedStatus, "open-stream-after-revocation");
      record("existing-business-stream-not-server-closed", provider.messages.at(-1).type === "status");
      record("revoked-session-cannot-open-new-stream", await rejects(() => business("provider", session)));
      const stalePassword = await control();
      record("old-password-rejected-after-change", await rejects(() => stalePassword.authenticate(password)));
      const changed = await control();
      const changedSession = await changed.authenticate(replacement);
      record("new-password-epoch-two", changedSession.pwdEpoch === 2);
      return results;
    } finally {
      for (const connection of sockets) connection.close();
    }
  }), sleep(60000, undefined, { ref: false }).then(() => { throw new Error("Protocol browser evaluation exceeded 60 seconds"); })]);
  assert.equal(results.length, 20);
  assert.ok(results.every((item) => item.passed));
  assert.deepEqual(pageErrors, []);
  await context.close();
  await browser.close();
  browser = null;
  const exitCode = await stopFixture();
  assert.equal(exitCode, 0, "Fixture did not shut down cleanly");
  assert.equal(existsSync(path.join(cache, ready.temporaryDirectory)), false, "Fixture private data was not removed");
  const harnessFiles = ["docs/scripts/protocol-fixture.py", "docs/scripts/probe-service-protocol.mjs"];
  const report = {
    checkedAt: new Date().toISOString(), backendRevision, clientRevision,
    backendSources, clientSources,
    harnessSources: Object.fromEntries(harnessFiles.map((file) => [file, sha(lf(readFileSync(path.join(root, file))))])),
    clientBundleSha256: sha(readFileSync(bundle)),
    packages: ready.packages,
    browser: "Microsoft Edge, headless Playwright context", runtime: { node: process.versions.node, bunBundler: bunVersion },
    cases: results.length, results, pageErrors,
    crypto: "Unmodified production X25519, Ed25519 verification, Argon2id, HKDF-SHA256, ChaCha20-Poly1305 and XChaCha20-Poly1305 SecretStream",
    adapters: "Production Control/Provider/Sync routes, HTTP remember/logout, auth manager, ConfigManager and TS client; deterministic runtime status/log queues, no ServiceContext startup",
    scope: "Loopback HTTP/WS interoperability fixture, not a TLS/reverse-proxy deployment, packaged native client, full WebsocketStore recovery, task execution or timing benchmark. Trigger/Remote/Android/system-log routes are excluded. The open-stream revocation case records a current security limitation, not successful enforcement.",
    cleanup: { browserClosed: true, fixtureExitCode: exitCode, temporaryAuthAndConfigRemoved: true },
    sensitiveDataPublished: false, gameOrDeviceAccessed: false,
  };
  writeFileSync(path.join(root, "docs/evidence/service-protocol-validation.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ cases: results.length, backendSources: backendSources.length, clientSources: clientSources.length, fixtureExitCode: exitCode }));
} finally {
  if (browser) await browser.close();
  if (child.exitCode === null) await stopFixture();
  writeFileSync(path.join(cache, "server-stderr.log"), Buffer.concat(stderrChunks));
}

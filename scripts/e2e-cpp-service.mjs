import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareCppServiceProjectRoot } from "./smoke-cpp-service.mjs";
import { validateServiceExecutable } from "./stage-cpp-service.mjs";

const STARTUP_TIMEOUT_MS = 15_000;
const MESSAGE_TIMEOUT_MS = 10_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const MAX_HTTP_BYTES = 64 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const MAX_SAFE_TRIGGER_TIMESTAMP = 9_007_199_254_740_991;
const textDecoder = new TextDecoder();

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  if (!port) throw new Error("failed to reserve a loopback port");
  return port;
}

async function strictJson(port, path, method = "GET") {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    signal: AbortSignal.timeout(1_000),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_HTTP_BYTES) throw new Error(`${path} response exceeds 64 KiB`);
  return { status: response.status, value: JSON.parse(textDecoder.decode(bytes)) };
}

class MessageInbox {
  constructor(name) {
    this.name = name;
    this.messages = [];
    this.waiters = [];
    this.failure = null;
  }

  push(message) {
    if (this.failure) return;
    const index = this.waiters.findIndex(({ predicate }) => predicate(message));
    if (index >= 0) {
      const [{ resolve, timer }] = this.waiters.splice(index, 1);
      clearTimeout(timer);
      resolve(message);
      return;
    }
    this.messages.push(message);
  }

  fail(error) {
    if (this.failure) return;
    this.failure = error instanceof Error ? error : new Error(String(error));
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(this.failure);
    }
  }

  waitFor(predicate, description, timeout = MESSAGE_TIMEOUT_MS) {
    if (this.failure) return Promise.reject(this.failure);
    const index = this.messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`timed out waiting for ${this.name} ${description}`));
      }, timeout);
      this.waiters.push(waiter);
    });
  }
}

class TriggerClient {
  constructor(connection) {
    this.connection = connection;
    this.pending = new Map();
    this.awaitingBinary = null;
    this.failure = null;
  }

  fail(error) {
    if (this.failure) return;
    this.failure = error instanceof Error ? error : new Error(String(error));
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.failure);
    }
    this.pending.clear();
    this.awaitingBinary = null;
  }

  receive(message) {
    try {
      if (message instanceof ArrayBuffer) {
        requireCondition(
          this.awaitingBinary !== null,
          "trigger returned an unannounced binary frame"
        );
        const pending = this.awaitingBinary;
        this.awaitingBinary = null;
        const bytes = new Uint8Array(message);
        requireCondition(
          bytes.byteLength === pending.binarySize,
          `trigger binary length mismatch: expected ${pending.binarySize}, got ${bytes.byteLength}`
        );
        clearTimeout(pending.timer);
        this.pending.delete(pending.timestamp);
        pending.resolve({ response: pending.response, binary: bytes });
        return;
      }

      requireCondition(
        message?.type === "command_response",
        "trigger returned a non-response JSON frame"
      );
      const timestamp = message.timestamp;
      requireCondition(
        Number.isSafeInteger(timestamp) &&
          timestamp >= 0 &&
          timestamp <= MAX_SAFE_TRIGGER_TIMESTAMP,
        `trigger returned an unsafe timestamp: ${String(timestamp)}`
      );
      const pending = this.pending.get(timestamp);
      requireCondition(Boolean(pending), `trigger echoed an unknown timestamp: ${timestamp}`);
      requireCondition(
        message.command === pending.command,
        "trigger response command did not match request"
      );

      const binarySize = message?.data?.binary?.size;
      if (binarySize !== undefined) {
        requireCondition(this.awaitingBinary === null, "trigger interleaved binary responses");
        requireCondition(
          Number.isSafeInteger(binarySize) && binarySize >= 0,
          "trigger returned an invalid binary size"
        );
        pending.response = message;
        pending.binarySize = binarySize;
        this.awaitingBinary = pending;
        return;
      }

      clearTimeout(pending.timer);
      this.pending.delete(timestamp);
      pending.resolve({ response: message, binary: null });
    } catch (error) {
      this.fail(error);
    }
  }

  command(command, timestamp, payload = {}, binary = null) {
    if (this.failure) return Promise.reject(this.failure);
    requireCondition(
      Number.isSafeInteger(timestamp) && timestamp >= 0 && timestamp <= MAX_SAFE_TRIGGER_TIMESTAMP,
      `test timestamp is outside the safe integer contract: ${String(timestamp)}`
    );
    requireCondition(!this.pending.has(timestamp), `duplicate test timestamp: ${timestamp}`);

    return new Promise((resolve, reject) => {
      const pending = {
        command,
        timestamp,
        resolve,
        reject,
        response: null,
        binarySize: null,
        timer: setTimeout(() => {
          this.pending.delete(timestamp);
          if (this.awaitingBinary === pending) this.awaitingBinary = null;
          reject(new Error(`timed out waiting for trigger ${command} timestamp=${timestamp}`));
        }, MESSAGE_TIMEOUT_MS),
      };
      this.pending.set(timestamp, pending);
      try {
        this.connection.sendJson({
          type: "command",
          command,
          timestamp,
          payload: binary === null ? payload : { ...payload, binary: true },
        });
        if (binary !== null) this.connection.sendBytes(binary);
      } catch (error) {
        clearTimeout(pending.timer);
        this.pending.delete(timestamp);
        reject(error);
      }
    });
  }
}

async function waitForReady(port, runtimeRepositoryGeneration, hasExited) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline && !hasExited()) {
    try {
      const version = await strictJson(port, "/version");
      const health = await strictJson(port, "/health");
      if (
        version.status === 200 &&
        version.value?.ok === true &&
        version.value?.api_version === 1 &&
        version.value?.service === "BAAS Service" &&
        health.status === 200 &&
        health.value?.ok === true &&
        health.value?.statuses?.runtime?.phase === "ready" &&
        health.value?.statuses?.runtime?.repository?.phase === "pinned" &&
        health.value?.statuses?.runtime?.repository?.generation === runtimeRepositoryGeneration &&
        typeof health.value?.auth?.server_sign_public_key === "string"
      ) {
        return health.value;
      }
    } catch {
      // Only startup connection races are tolerated before the deadline.
    }
    await delay(100);
  }
  throw new Error("real BAAS_service did not publish strict ready identity");
}

async function waitForConfigList(sync, inbox, predicate, description) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    sync.sendJson({ type: "list" });
    const listed = await inbox.waitFor(
      (message) => message?.type === "config_list" && Array.isArray(message.data),
      "config_list"
    );
    if (predicate(listed.data)) return listed;
    await delay(50);
  }
  throw new Error(`sync config_list never ${description}`);
}

export async function e2eCppService(
  executable = process.env.BAAS_CPP_SERVICE_PATH,
  remoteJar = process.env.BAAS_CPP_SERVICE_REMOTE_JAR
) {
  if (!executable) throw new Error("BAAS_CPP_SERVICE_PATH is required for real websocket E2E");
  if (!remoteJar) throw new Error("BAAS_CPP_SERVICE_REMOTE_JAR is required for real websocket E2E");

  const canonical = await validateServiceExecutable(executable);
  const projectRoot = await mkdtemp(join(tmpdir(), "baas-cpp-service-e2e-"));
  let child;
  let exited = false;
  let exit;
  const output = [];
  let outputBytes = 0;
  const connections = [];
  let control = null;

  try {
    const { runtimeRepositoryGeneration } = await prepareCppServiceProjectRoot(
      projectRoot,
      remoteJar
    );
    const port = await availablePort();
    child = spawn(
      canonical,
      [
        "--project-root",
        projectRoot,
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--runtime-repository-generation",
        runtimeRepositoryGeneration,
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
    );
    const capture = (chunk) => {
      if (outputBytes >= MAX_PROCESS_OUTPUT_BYTES) return;
      const bounded = chunk.subarray(0, MAX_PROCESS_OUTPUT_BYTES - outputBytes);
      output.push(bounded);
      outputBytes += bounded.byteLength;
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    exit = new Promise((resolve) =>
      child.once("exit", (code, signal) => {
        exited = true;
        resolve({ code, signal });
      })
    );

    const health = await waitForReady(port, runtimeRepositoryGeneration, () => exited);
    process.env.VITE_BAAS_SERVER_SIGN_PUBLIC_KEY_B64 = health.auth.server_sign_public_key;
    const { ControlConnection, SecureWebSocket } = await import("../src/shared/SecureWebSocket.ts");
    const websocketBase = `ws://127.0.0.1:${port}`;
    control = await ControlConnection.open(`${websocketBase}/ws/control`);
    requireCondition(
      control.initialized === false,
      "fresh E2E auth root was unexpectedly initialized"
    );
    const session = await control.authenticate("cpp-e2e-password");
    requireCondition(
      session.authMode === "password",
      "control authentication did not use password mode"
    );
    requireCondition(
      session.masterSecret.byteLength === 32,
      "control session master secret is invalid"
    );

    const providerInbox = new MessageInbox("provider");
    const syncInbox = new MessageInbox("sync");
    const provider = new SecureWebSocket(
      `${websocketBase}/ws/provider`,
      "provider",
      session,
      "arraybuffer"
    );
    const sync = new SecureWebSocket(`${websocketBase}/ws/sync`, "sync", session, "arraybuffer");
    const trigger = new SecureWebSocket(
      `${websocketBase}/ws/trigger`,
      "trigger",
      session,
      "arraybuffer"
    );
    connections.push(provider, sync, trigger);
    const triggerClient = new TriggerClient(trigger);
    for (const [connection, inbox] of [
      [provider, providerInbox],
      [sync, syncInbox],
    ]) {
      connection.onError = () => inbox.fail(new Error(`${inbox.name} websocket error`));
      connection.onClose = (event) =>
        inbox.fail(
          new Error(`${inbox.name} websocket closed early: ${event.reason || event.code}`)
        );
    }
    trigger.onError = () => triggerClient.fail(new Error("trigger websocket error"));
    trigger.onClose = (event) =>
      triggerClient.fail(
        new Error(`trigger websocket closed early: ${event.reason || event.code}`)
      );

    await provider.connect((message) => providerInbox.push(message));
    await sync.connect((message) => syncInbox.push(message));
    await trigger.connect((message) => triggerClient.receive(message));
    requireCondition(provider.readyState === WebSocket.OPEN, "provider websocket did not open");
    requireCondition(sync.readyState === WebSocket.OPEN, "sync websocket did not open");
    requireCondition(trigger.readyState === WebSocket.OPEN, "trigger websocket did not open");

    // The high, exactly representable integer catches timestamp narrowing and
    // correlation bugs without crossing JSON's interoperable integer ceiling.
    let timestamp = MAX_SAFE_TRIGGER_TIMESTAMP - 1_024;
    const status = await triggerClient.command("status", timestamp++);
    requireCondition(status.response.status === "ok", "status trigger did not succeed");
    requireCondition(
      status.response.timestamp === MAX_SAFE_TRIGGER_TIMESTAMP - 1_024,
      "status callback did not preserve the exact safe integer timestamp"
    );
    requireCondition(status.binary === null, "status trigger unexpectedly returned binary data");

    await waitForConfigList(
      sync,
      syncInbox,
      (ids) => ids.includes("source"),
      "reported the fixture config"
    );

    const added = await triggerClient.command("add_config", timestamp++, {
      name: "Tauri C++ E2E",
      server: "日服",
    });
    requireCondition(
      added.response.status === "ok",
      `add_config failed: ${JSON.stringify(added.response)}`
    );
    const serial = added.response?.data?.serial;
    requireCondition(
      typeof serial === "string" && /^\d+$/u.test(serial),
      "add_config returned an invalid serial"
    );

    await waitForConfigList(
      sync,
      syncInbox,
      (ids) => ids.includes(serial),
      "included the added config"
    );
    sync.sendJson({ type: "pull", resource: "config", resource_id: serial });
    const snapshot = await syncInbox.waitFor(
      (message) =>
        message?.type === "snapshot" &&
        message.resource === "config" &&
        message.resource_id === serial,
      "added config snapshot"
    );
    requireCondition(
      snapshot.data?.name === "Tauri C++ E2E",
      "sync pull returned the wrong config name"
    );
    requireCondition(
      snapshot.data?.server === "日服",
      "sync pull returned the wrong config server"
    );

    const exported = await triggerClient.command("export_config", timestamp++, { id: serial });
    requireCondition(
      exported.response.status === "ok",
      `export_config failed: ${JSON.stringify(exported.response)}`
    );
    requireCondition(
      exported.response?.data?.filename === "Tauri C++ E2E.zip",
      "export_config returned the wrong filename"
    );
    requireCondition(
      exported.binary instanceof Uint8Array && exported.binary.byteLength > 0,
      "export_config returned no archive bytes"
    );

    const removed = await triggerClient.command("remove_config", timestamp++, { id: serial });
    requireCondition(
      removed.response.status === "ok",
      `remove_config failed: ${JSON.stringify(removed.response)}`
    );
    requireCondition(
      removed.response.data && Object.keys(removed.response.data).length === 0,
      "remove_config did not preserve the empty-object response contract"
    );
    await waitForConfigList(
      sync,
      syncInbox,
      (ids) => !ids.includes(serial),
      "removed the exported config"
    );

    const imported = await triggerClient.command("import_config", timestamp++, {}, exported.binary);
    requireCondition(
      imported.response.status === "ok",
      `import_config failed: ${JSON.stringify(imported.response)}`
    );
    const importedSerial = imported.response?.data?.serial;
    requireCondition(
      typeof importedSerial === "string" && /^\d+$/u.test(importedSerial),
      "import_config returned an invalid serial"
    );
    requireCondition(
      imported.response?.data?.name === "Tauri C++ E2E",
      "import_config returned the wrong name"
    );
    await waitForConfigList(
      sync,
      syncInbox,
      (ids) => ids.includes(importedSerial),
      "included the imported config"
    );
    sync.sendJson({ type: "pull", resource: "config", resource_id: importedSerial });
    const importedSnapshot = await syncInbox.waitFor(
      (message) =>
        message?.type === "snapshot" &&
        message.resource === "config" &&
        message.resource_id === importedSerial,
      "imported config snapshot"
    );
    requireCondition(
      importedSnapshot.data?.name === "Tauri C++ E2E",
      "sync pull did not observe the imported archive"
    );

    const cleanup = await triggerClient.command("remove_config", timestamp++, {
      id: importedSerial,
    });
    requireCondition(cleanup.response.status === "ok", "imported config cleanup failed");
    await waitForConfigList(
      sync,
      syncInbox,
      (ids) => !ids.includes(importedSerial),
      "removed the imported config"
    );

    for (const connection of connections.reverse()) connection.close();
    connections.length = 0;
    control.close();
    control = null;
    await delay(50);

    const shutdown = await strictJson(port, "/shutdown", "POST");
    requireCondition(
      shutdown.status === 202 &&
        shutdown.value?.ok === true &&
        shutdown.value?.api_version === 1 &&
        shutdown.value?.accepted === true,
      `unexpected shutdown response: ${JSON.stringify(shutdown)}`
    );
    const result = await Promise.race([
      exit,
      delay(SHUTDOWN_TIMEOUT_MS).then(() => {
        throw new Error("real BAAS_service did not exit after shutdown");
      }),
    ]);
    requireCondition(
      result.code === 0 && !result.signal,
      `real BAAS_service exited abnormally: ${JSON.stringify(result)}`
    );
    return { executable: canonical, port, serial: importedSerial };
  } catch (error) {
    const processOutput = Buffer.concat(output).toString("utf8");
    throw new Error(
      `${error instanceof Error ? error.message : error}${processOutput ? `\n${processOutput}` : ""}`
    );
  } finally {
    for (const connection of connections.reverse()) {
      try {
        connection.close();
      } catch {
        // Best-effort cleanup after the asserted failure has been retained.
      }
    }
    try {
      control?.close();
    } catch {
      // Best-effort cleanup after the asserted failure has been retained.
    }
    if (child && !exited) {
      child.kill("SIGKILL");
      if (exit) await Promise.race([exit, delay(2_000)]);
    }
    await rm(projectRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  e2eCppService()
    .then(({ executable, port, serial }) =>
      console.log(
        `Real C++ websocket E2E passed: ${executable} port=${port} imported_serial=${serial}`
      )
    )
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}

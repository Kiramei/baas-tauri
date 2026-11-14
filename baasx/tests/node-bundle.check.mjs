// Executed with Node after `baasx:binary` builds the registry bundle and helper.
// This file is intentionally not named *.test.mjs: Bun tests run before builds.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, URL } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url));
const bundle = path.join(project, "dist", "baasx-node.mjs");
const helper = process.platform === "win32" ? "baasx-runtime.exe" : "baasx-runtime";
const cleanEnv = { ...process.env };
for (const key of ["BAAS_KEY", "BAAS_PIPE", "BAAS_PROFILE", "BAAS_RUNTIME_HELPER", "BAASX_RUNTIME_HELPER", "BAAS_SERVER"])
  delete cleanEnv[key];

test("Node bundle executes demo commands without a Bun executable", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "baasx-node-demo-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [bundle, "--config-home", directory, "--demo", "--json", "status"], {
    env: cleanEnv,
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout)["sensei-cn"].running, false);
});

test("Node bundle finds the matching platform helper inside a registry package", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "baasx-node-helper-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dist = path.join(directory, "package", "dist");
  const platformName = `@kiramei/baasx-${process.platform}-${process.arch}`;
  const platform = path.join(directory, "package", "node_modules", platformName);
  const runtime = path.join(platform, "runtime");
  const bin = path.join(directory, "package", "bin");
  mkdirSync(bin, { recursive: true });
  copyFileSync(path.join(project, "registry", "baasx.mjs"), path.join(bin, "baasx.mjs"));
  mkdirSync(dist, { recursive: true });
  mkdirSync(runtime, { recursive: true });
  writeFileSync(
    path.join(platform, "package.json"),
    JSON.stringify({ name: platformName, exports: { "./helper": "./runtime/" + helper } })
  );
  copyFileSync(bundle, path.join(dist, "baasx-node.mjs"));
  copyFileSync(path.join(project, "dist", "runtime", helper), path.join(runtime, helper));
  // An empty config has no managed runtime, so the real helper exits before
  // any update network request. Its error shows that the helper was located.
  const result = spawnSync(process.execPath, [path.join(bin, "baasx.mjs"), "--config-home", path.join(directory, "config"), "--json", "check-update"], {
    env: cleanEnv,
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(JSON.parse(result.stdout).error, /updates require a complete CLI-managed (?:dev )?runtime/);
});

test("new bundles find older unpacked runtime filenames", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "baasx-legacy-bundle-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dist = path.join(directory, "dist");
  const runtime = path.join(directory, "runtime");
  mkdirSync(dist);
  mkdirSync(runtime);
  copyFileSync(bundle, path.join(dist, "baasx-node.mjs"));
  copyFileSync(path.join(project, "dist", "runtime", helper), path.join(runtime, helper.replace("baasx", "baas-cli")));
  const status = spawnSync(process.execPath, [path.join(dist, "baasx-node.mjs"), "--config-home", directory, "--json", "check-update"], { env: cleanEnv, encoding: "utf8" });
  assert.equal(status.status, 1);
  assert.match(JSON.parse(status.stdout).error, /updates require a complete CLI-managed (?:dev )?runtime/);
});

test("Node bundle reads profiles and configuration and starts scheduling over BPIP", { timeout: 45_000 }, async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "baasx-node-pipe-"));
  const endpoint = process.platform === "win32"
    ? `\\\\.\\pipe\\baasx-node-${process.pid}-${Date.now()}`
    : path.join(directory, "service.sock");
  const sockets = new Set();
  const received = [];
  let child, fixtureError;
  const send = (socket, message) => {
    const payload = Buffer.from(JSON.stringify(message));
    const frame = Buffer.alloc(10 + payload.length);
    frame.write("BPIP");
    frame[4] = 1;
    frame[5] = 1;
    frame.writeUInt32LE(payload.length, 6);
    payload.copy(frame, 10);
    socket.write(frame);
  };
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", (error) => { fixtureError ??= error; });
    let pending = Buffer.alloc(0), channel;
    socket.on("data", (chunk) => {
      try {
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= 10) {
          assert.equal(pending.subarray(0, 6).toString("hex"), "425049500101");
          const length = pending.readUInt32LE(6);
          assert.ok(length < 65_536, "Unexpected fixture frame size");
          if (pending.length < 10 + length) break;
          const message = JSON.parse(pending.subarray(10, 10 + length).toString("utf8"));
          pending = pending.subarray(10 + length);
          if (message.type === "open") {
            assert.equal(channel, undefined);
            channel = message.channel;
            send(socket, { type: "open_ok", channel });
          } else if (message.type === "list") {
            assert.equal(channel, "sync");
            send(socket, { type: "config_list", data: ["alpha"] });
          } else if (message.type === "pull") {
            assert.equal(channel, "sync");
            assert.equal(message.resource, "config");
            assert.equal(message.resource_id, "alpha");
            send(socket, { type: "snapshot", resource: "config", resource_id: "alpha", timestamp: 42, data: { name: "Arona", server: "Global" } });
          } else {
            assert.equal(channel, "trigger");
            assert.equal(message.type, "command");
            assert.equal(message.command, "start_scheduler");
            assert.equal(message.config_id, "alpha");
            assert.deepEqual(message.payload, {});
            assert.ok(Number.isFinite(message.timestamp));
            // A response for another request must not satisfy this scheduler call.
            send(socket, { type: "command_response", command: message.command, timestamp: message.timestamp + 1, status: "ok", data: { status: "started", run_id: "wrong-run" } });
            send(socket, { type: "command_response", command: message.command, timestamp: message.timestamp, status: "ok", data: { status: "started", config_id: "alpha", run_id: "pipe-run" } });
          }
          received.push({ channel, message });
        }
      } catch (error) {
        fixtureError ??= error;
        socket.destroy();
      }
    });
  });
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = new Promise((resolve) => child.once("close", resolve));
      child.kill();
      await closed;
    }
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
  const run = async (...args) => {
    const before = received.length;
    child = spawn(process.execPath, [bundle, "--config-home", directory, "--pipe", endpoint, "--json", "--profile", "alpha", ...args], {
      env: cleanEnv,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.ifError(fixtureError);
    assert.equal(code, 0, stderr || stdout);
    assert.equal(stderr, "");
    assert.deepEqual(received.slice(before).filter(({ message }) => message.type === "open").map(({ channel }) => channel).sort(), ["provider", "sync", "trigger"]);
    return JSON.parse(stdout);
  };
  assert.deepEqual(await run("profiles"), { alpha: "Arona" });
  assert.equal(await run("config", "get", "/server"), "Global");
  assert.deepEqual(await run("start"), {
    accepted: true,
    completed: false,
    run_id: "pipe-run",
    result: { status: "started", config_id: "alpha", run_id: "pipe-run" },
  });
  assert.equal(received.filter(({ message }) => message.type === "command").length, 1);
});

test("Node 20 WebSocket fallback sends the BAAS control handshake", { timeout: 20_000 }, async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "baasx-node-websocket-"));
  const server = http.createServer();
  let peer;
  t.after(() => {
    peer?.destroy();
    server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const greeting = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("upgrade", (request, socket) => {
      peer = socket;
      const accept = createHash("sha1")
        .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      let pending = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        pending = Buffer.concat([pending, chunk]);
        if (pending.length < 2) return;
        let length = pending[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (pending.length < 4) return;
          length = pending.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          reject(new Error("unexpected oversized WebSocket frame"));
          return;
        }
        if (!(pending[1] & 0x80) || pending.length < offset + 4 + length) return;
        const mask = pending.subarray(offset, offset + 4);
        const message = Buffer.from(pending.subarray(offset + 4, offset + 4 + length));
        for (let index = 0; index < message.length; index++) message[index] ^= mask[index % 4];
        try {
          resolve({ path: request.url, body: JSON.parse(message.toString("utf8")) });
        } catch (error) {
          reject(error);
        }
        socket.destroy();
      });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const child = spawn(process.execPath, [bundle, "--config-home", directory, "--server", `ws://127.0.0.1:${server.address().port}`, "--json", "--timeout", "5000", "status"], {
    env: { ...cleanEnv, BAAS_KEY: "local-fixture-key" },
    stdio: "ignore",
  });
  t.after(() => child.kill());
  const message = await greeting;
  assert.equal(message.path, "/ws/control");
  assert.equal(message.body.type, "client_hello");
});

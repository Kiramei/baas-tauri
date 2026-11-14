// Executed with Node after `baasx:binary` builds the registry bundle and helper.
// This file is intentionally not named *.test.mjs: Bun tests run before builds.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, URL } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url));
const bundle = path.join(project, "dist", "baasx-node.mjs");
const helper = process.platform === "win32" ? "baas-cli-runtime.exe" : "baas-cli-runtime";
const cleanEnv = { ...process.env };
for (const key of ["BAAS_KEY", "BAAS_PIPE", "BAAS_PROFILE", "BAAS_RUNTIME_HELPER", "BAAS_SERVER"])
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
  const runtime = path.join(directory, "package", "platforms", `${process.platform}-${process.arch}`, "runtime");
  mkdirSync(dist, { recursive: true });
  mkdirSync(runtime, { recursive: true });
  copyFileSync(bundle, path.join(dist, "baasx-node.mjs"));
  copyFileSync(path.join(project, "dist", "runtime", helper), path.join(runtime, helper));
  // An empty config has no managed runtime, so the real helper exits before
  // any update network request. Its error shows that the helper was located.
  const result = spawnSync(process.execPath, [path.join(dist, "baasx-node.mjs"), "--config-home", path.join(directory, "config"), "--json", "check-update"], {
    env: cleanEnv,
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(JSON.parse(result.stdout).error, /updates require a complete CLI-managed runtime/);
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

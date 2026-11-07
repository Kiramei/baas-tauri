import { afterEach, expect, test } from "bun:test";
import { createHash, hkdfSync } from "node:crypto";
import sodium from "libsodium-wrappers-sumo";
import { BaasClient } from "../src/index";

type Data = Record<string, any>;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const unb64 = (value: string) => new Uint8Array(Buffer.from(value, "base64url"));
const bytes = (value: string) => encoder.encode(value);
const normalize = (value: any): any =>
  Array.isArray(value)
    ? value.map(normalize)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, normalize(value[key])])
        )
      : value;
const canonical = (value: any) => bytes(JSON.stringify(normalize(value)));
const hash = (value: Uint8Array) => new Uint8Array(createHash("sha256").update(value).digest());
const hkdf = (key: Uint8Array, info: string | Uint8Array, salt: Uint8Array, length = 32) =>
  new Uint8Array(
    hkdfSync("sha256", key, salt, typeof info === "string" ? bytes(info) : info, length)
  );
const concat = (...items: Uint8Array[]) => new Uint8Array(Buffer.concat(items));
const sequence = (value: number, length = 8) => {
  const nonce = new Uint8Array(length);
  new DataView(nonce.buffer).setBigUint64(length - 8, BigInt(value), false);
  return nonce;
};

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A signed fixture peer validates the entire client handshake and encrypted wire. */
async function secureFixture(options: { silentFirst?: boolean } = {}) {
  await sodium.ready;
  const signing = sodium.crypto_sign_keypair();
  const salt = sodium.randombytes_buf(16);
  const params = {
    algorithm: "argon2id",
    opslimit: 1,
    memlimit: 8192,
    salt_bytes: 16,
    hash_bytes: 32,
  };
  const passwordKey = sodium.crypto_pwhash(
    32,
    "fixture-passphrase",
    salt,
    1,
    8192,
    sodium.crypto_pwhash_ALG_ARGON2ID13
  );
  const peerErrors: unknown[] = [];
  const sockets = new Set<any>();
  let upgrades = 0;
  let receivedFirst!: () => void;
  const firstMessage = new Promise<void>((resolve) => {
    receivedFirst = resolve;
  });
  let session: Data = {};
  const secureEncrypt = (state: Data, payload: Data) => {
    const seq = state.txSeq++;
    return {
      type: "secure",
      seq,
      ciphertext: b64(
        sodium.crypto_aead_chacha20poly1305_ietf_encrypt(
          canonical(payload),
          canonical({ seq, type: "secure" }),
          null,
          sequence(seq, 12),
          state.txKey
        )
      ),
    };
  };
  const secureDecrypt = (state: Data, payload: Data): Data => {
    if (payload.seq !== state.rxSeq++)
      throw new Error("Fixture received out-of-order control frame");
    return JSON.parse(
      decoder.decode(
        sodium.crypto_aead_chacha20poly1305_ietf_decrypt(
          null,
          unb64(payload.ciphertext),
          canonical({ seq: payload.seq, type: "secure" }),
          sequence(payload.seq, 12),
          state.rxKey
        )
      )
    );
  };
  const sendStream = (socket: any, message: Data) => {
    const state = socket.data;
    socket.send(
      sodium.crypto_secretstream_xchacha20poly1305_push(
        state.push.state,
        canonical(message),
        concat(state.aad, sequence(state.streamTx++)),
        0
      )
    );
  };
  const handle = async (socket: any, raw: string | Buffer) => {
    const state = socket.data;
    receivedFirst();
    if (state.silent) return;
    if (state.stage === "hello") {
      const hello = JSON.parse(String(raw));
      state.hello = hello;
      const keypair = sodium.crypto_kx_keypair();
      const core = {
        type: "server_hello",
        kind: hello.kind,
        channel: hello.channel,
        version: 1,
        initialized: true,
        pwd_epoch: 1,
        pwd_salt: b64(salt),
        argon2: params,
        server_nonce: b64(sodium.randombytes_buf(32)),
        server_kx_pub: b64(keypair.publicKey),
      };
      const transcript = canonical({
        kind: hello.kind,
        channel: hello.channel,
        client: hello,
        server: core,
      });
      state.shared = sodium.crypto_scalarmult(keypair.privateKey, unb64(hello.client_kx_pub));
      state.transcriptHash = hash(transcript);
      state.rxKey = hkdf(state.shared, "preauth:server-rx", state.transcriptHash);
      state.txKey = hkdf(state.shared, "preauth:server-tx", state.transcriptHash);
      state.txSeq = state.rxSeq = 0;
      state.stage = hello.kind === "control" ? "authenticate" : "resume";
      socket.send(
        JSON.stringify({
          ...core,
          signature: b64(sodium.crypto_sign_detached(transcript, signing.privateKey)),
          server_sign_pub: b64(signing.publicKey),
        })
      );
      return;
    }
    if (state.stage === "authenticate") {
      const request = secureDecrypt(state, JSON.parse(String(raw)));
      const authContext = hkdf(state.shared, "auth-proof:1", state.transcriptHash);
      if (
        request.type !== "authenticate" ||
        !sodium.memcmp(
          unb64(request.proof),
          sodium.crypto_auth_hmacsha256(authContext, passwordKey)
        )
      ) {
        socket.close(4401, "Wrong login Key");
        return;
      }
      session = {
        masterSecret: hkdf(
          concat(state.shared, passwordKey),
          "master-secret",
          state.transcriptHash
        ),
      };
      session.resumeSecret = hkdf(session.masterSecret, "resume-secret", state.transcriptHash);
      socket.send(
        JSON.stringify(
          secureEncrypt(state, {
            type: "auth_ok",
            session_id: "fixture-session",
            resume_ticket: "fixture-ticket",
            pwd_epoch: 1,
            expires_at: Date.now() / 1000 + 3600,
            pwd_salt: b64(salt),
            argon2: params,
          })
        )
      );
      state.stage = "control";
      return;
    }
    if (state.stage === "resume") {
      const request = secureDecrypt(state, JSON.parse(String(raw)));
      const context = {
        transcript_hash: b64(state.transcriptHash),
        session_id: "fixture-session",
        socket_id: state.hello.socket_id,
        channel: state.hello.channel,
        pwd_epoch: 1,
      };
      // Client encoding includes base64 padding; compare the decoded MAC using its exact transcript text.
      context.transcript_hash = Buffer.from(state.transcriptHash)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
      if (
        !sodium.memcmp(
          unb64(request.resume_mac),
          sodium.crypto_auth_hmacsha256(canonical(context), session.resumeSecret)
        )
      )
        throw new Error("Invalid resume proof");
      const scope = {
        scope: "ws",
        session_id: "fixture-session",
        socket_id: state.hello.socket_id,
        channel: state.hello.channel,
        pwd_epoch: 1,
      };
      const base = hkdf(session.masterSecret, canonical(scope), state.transcriptHash, 64);
      const txKey = hkdf(base.slice(0, 32), "secretstream:server-tx", state.transcriptHash);
      state.streamRxKey = hkdf(base.slice(32), "secretstream:server-rx", state.transcriptHash);
      state.push = sodium.crypto_secretstream_xchacha20poly1305_init_push(txKey);
      state.aad = canonical({
        session_id: "fixture-session",
        socket_id: state.hello.socket_id,
        channel: state.hello.channel,
        pwd_epoch: 1,
      });
      state.streamTx = state.streamRx = 0;
      socket.send(
        JSON.stringify(
          secureEncrypt(state, { type: "resume_ok", server_header: b64(state.push.header) })
        )
      );
      state.stage = "ready";
      return;
    }
    if (state.stage === "ready") {
      const request = secureDecrypt(state, JSON.parse(String(raw)));
      state.pull = sodium.crypto_secretstream_xchacha20poly1305_init_pull(
        unb64(request.client_header),
        state.streamRxKey
      );
      state.stage = "business";
      if (state.hello.channel === "provider") {
        sendStream(socket, { type: "logs_full", scopes: [], entries: [] });
        sendStream(socket, { type: "status", status: {} });
      }
      return;
    }
    if (state.stage === "business") {
      const result = sodium.crypto_secretstream_xchacha20poly1305_pull(
        state.pull,
        new Uint8Array(raw as Buffer),
        concat(state.aad, sequence(state.streamRx++))
      );
      if (!result) throw new Error("Invalid encrypted business frame");
      const request = JSON.parse(decoder.decode(result.message));
      if (request.type === "command")
        sendStream(socket, {
          type: "command_response",
          command: request.command,
          timestamp: request.timestamp,
          status: "ok",
          data: { alpha: { running: false } },
        });
      else if (request.type === "list")
        sendStream(socket, { type: "config_list", timestamp: Date.now(), data: ["alpha"] });
      else if (request.type === "pull")
        sendStream(socket, {
          type: "snapshot",
          resource: request.resource,
          resource_id: request.resource_id,
          timestamp: Date.now(),
          data: { name: "Arona" },
        });
    }
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (
        server.upgrade(request, {
          data: { stage: "hello", silent: !!options.silentFirst && upgrades++ === 0 },
        })
      )
        return;
      return new Response("WebSocket required", { status: 400 });
    },
    websocket: {
      open(socket) {
        sockets.add(socket);
      },
      close(socket) {
        sockets.delete(socket);
      },
      message(socket, message) {
        void handle(socket, message as string | Buffer).catch((error) => {
          peerErrors.push(error);
          socket.close(1011, "Fixture protocol failure");
        });
      },
    },
  });
  const client = new BaasClient({
    url: `http://127.0.0.1:${server.port}`,
    key: "fixture-passphrase",
    serverSignPublicKey: b64(signing.publicKey),
    timeoutMs: 2000,
  });
  cleanups.push(() => {
    client.close();
    for (const socket of sockets) socket.close();
    server.stop(true);
  });
  return {
    client,
    peerErrors,
    firstMessage,
    url: `ws://127.0.0.1:${server.port}`,
    pin: b64(signing.publicKey),
  };
}

test("authenticates with a pinned signing key and exchanges encrypted business messages", async () => {
  const { client, peerErrors } = await secureFixture();
  expect(await client.status()).toEqual({ alpha: { running: false } });
  expect(await client.profiles()).toEqual({ alpha: "Arona" });
  expect(peerErrors).toEqual([]);
});

test("rejects an unexpected server identity before sending a password proof", async () => {
  const { url, peerErrors } = await secureFixture();
  const client = new BaasClient({ url, key: "fixture-passphrase", timeoutMs: 500 });
  cleanups.push(() => client.close());
  await expect(client.connect()).rejects.toThrow("pinned public key");
  expect(peerErrors).toEqual([]);
});

test("rejects a wrong login Key and releases the connection", async () => {
  const { url, pin, peerErrors } = await secureFixture();
  const client = new BaasClient({
    url,
    serverSignPublicKey: pin,
    key: "wrong-fixture-passphrase",
    timeoutMs: 500,
  });
  cleanups.push(() => client.close());
  await expect(client.connect()).rejects.toThrow("Wrong login Key");
  expect(peerErrors).toEqual([]);
});

test("applies the configured timeout to a silent authentication peer", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response("WebSocket required", { status: 400 });
    },
    websocket: { message() {} },
  });
  const client = new BaasClient({
    url: `ws://127.0.0.1:${server.port}`,
    key: "fixture-passphrase",
    timeoutMs: 30,
  });
  cleanups.push(() => {
    client.close();
    server.stop(true);
  });
  const started = Date.now();
  await expect(client.connect()).rejects.toThrow("Timed out");
  expect(Date.now() - started).toBeLessThan(1000);
});

test("close aborts an unfinished WebSocket handshake without a stale catch tearing down reconnection", async () => {
  const { client, firstMessage, peerErrors } = await secureFixture({ silentFirst: true });
  const opening = client.connect();
  await firstMessage;
  client.close();
  const next = client.connect();
  await expect(opening).rejects.toThrow("closed");
  await next;
  expect(await client.status()).toEqual({ alpha: { running: false } });
  expect(peerErrors).toEqual([]);
});

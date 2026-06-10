"use client";

import sodium from "libsodium-wrappers-sumo";

export type AuthPhase =
  | "idle"
  | "control_connecting"
  | "server_verified"
  | "waiting_password"
  | "resuming"
  | "initializing"
  | "authenticating"
  | "authenticated"
  | "revoked";

export interface ControlSessionBundle {
  sessionId: string;
  resumeTicket: string;
  pwdEpoch: number;
  expiresAt: number;
  masterSecret: Uint8Array;
  resumeSecret: Uint8Array;
  authMode?: "password" | "remember";
}

interface Argon2Params {
  algorithm: "argon2id";
  opslimit: number;
  memlimit: number;
  salt_bytes: number;
  hash_bytes: number;
}

interface ServerHelloMessage {
  type: "server_hello";
  kind: "control" | "resume";
  channel: string;
  version: number;
  initialized: boolean;
  pwd_epoch: number;
  pwd_salt: string | null;
  argon2: Argon2Params;
  server_nonce: string;
  server_kx_pub: string;
  signature: string;
  server_sign_pub: string;
}

interface SecureEnvelope {
  type: "secure";
  seq: number;
  ciphertext: string;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const DEFAULT_SERVER_SIGN_PUBLIC_KEY_B64 =
  import.meta.env.VITE_BAAS_SERVER_SIGN_PUBLIC_KEY_B64 ||
  "_GMKcfOCE-0_erXPJQRQv6mLiNBnT3tdHmAaXwWRis4=";

const PROTOCOL_VERSION = 1;

const toUint8Array = (value: ArrayBuffer | Uint8Array): Uint8Array =>
  value instanceof Uint8Array ? value : new Uint8Array(value);

const concatBytes = (...parts: Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  return merged;
};

const normalizeForCanonicalJson = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(normalizeForCanonicalJson);
  }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const source = value as Record<string, unknown>;
    return Object.keys(source)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = normalizeForCanonicalJson(source[key]);
        return acc;
      }, {});
  }
  return value;
};

const canonicalBytes = (value: unknown): Uint8Array =>
  textEncoder.encode(JSON.stringify(normalizeForCanonicalJson(value)));

const base64UrlToBytes = (base64Url: string): Uint8Array => {
  const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = base64.length % 4;
  const padded = base64 + (pad ? "=".repeat(4 - pad) : "");
  const raw = atob(padded);
  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
};

const bytesToBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

const nonceFromSeq = (seq: number): Uint8Array => {
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setBigUint64(4, BigInt(seq), false);
  return nonce;
};

const sha256 = async (data: Uint8Array): Promise<Uint8Array> => {
  if (globalThis.crypto?.subtle) {
    const buf = await crypto.subtle.digest("SHA-256", data);
    return new Uint8Array(buf);
  }
  await sodium.ready;
  const hash = sodium.crypto_hash_sha256(data);
  return new Uint8Array(hash);
};

const hkdfSha256 = async (
  keyMaterial: Uint8Array,
  info: Uint8Array,
  length: number,
  salt: Uint8Array
): Promise<Uint8Array> => {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const key = await subtle.importKey("raw", keyMaterial, "HKDF", false, ["deriveBits"]);
    const bits = await subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt,
        info,
      },
      key,
      length * 8
    );
    return new Uint8Array(bits);
  }
  await sodium.ready;
  const prk = sodium.crypto_auth_hmacsha256(keyMaterial, salt);
  const hashLen = 32;
  const n = Math.ceil(length / hashLen);
  let t = new Uint8Array(0);
  const okm = new Uint8Array(length);
  let pos = 0;

  for (let i = 1; i <= n; i++) {
    const input = new Uint8Array(t.length + info.length + 1);
    input.set(t, 0);
    input.set(info, t.length);
    input[input.length - 1] = i;

    t = sodium.crypto_auth_hmacsha256(input, prk);

    const sliceLen = Math.min(hashLen, length - pos);
    okm.set(t.slice(0, sliceLen), pos);
    pos += sliceLen;
  }

  return okm;
};

const waitForJsonMessage = (ws: WebSocket): Promise<Record<string, any>> =>
  new Promise((resolve, reject) => {
    const cleanup = () => {
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("close", onClose);
      ws.removeEventListener("error", onError);
    };

    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") {
        cleanup();
        reject(new Error("Expected a JSON websocket frame"));
        return;
      }
      try {
        const parsed = JSON.parse(event.data) as Record<string, any>;
        cleanup();
        resolve(parsed);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };

    const onClose = (event: CloseEvent) => {
      cleanup();
      reject(new Error(event.reason || "WebSocket closed before message was received"));
    };

    const onError = () => {
      cleanup();
      reject(new Error("WebSocket error before message was received"));
    };

    ws.addEventListener("message", onMessage);
    ws.addEventListener("close", onClose);
    ws.addEventListener("error", onError);
  });

const waitForOpen = (ws: WebSocket): Promise<void> =>
  new Promise((resolve, reject) => {
    const cleanup = () => {
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("close", onClose);
      ws.removeEventListener("error", onError);
    };

    const onOpen = () => {
      cleanup();
      resolve();
    };

    const onClose = (event: CloseEvent) => {
      cleanup();
      reject(new Error(event.reason || "WebSocket closed before open"));
    };

    const onError = () => {
      cleanup();
      reject(new Error("WebSocket failed before open"));
    };

    ws.addEventListener("open", onOpen);
    ws.addEventListener("close", onClose);
    ws.addEventListener("error", onError);
  });

const requireServerHello = (payload: Record<string, any>): ServerHelloMessage => {
  if (payload.type !== "server_hello") {
    throw new Error("Expected server_hello");
  }
  return payload as ServerHelloMessage;
};

class JsonSecureChannel {
  private txSeq = 0;
  private rxSeq = 0;
  private readonly txKey: Uint8Array;
  private readonly rxKey: Uint8Array;

  constructor(txKey: Uint8Array, rxKey: Uint8Array) {
    this.txKey = txKey;
    this.rxKey = rxKey;
  }

  encrypt(payload: Record<string, any>): SecureEnvelope {
    const seq = this.txSeq++;
    const nonce = nonceFromSeq(seq);
    const aad = canonicalBytes({ seq, type: "secure" });
    const ciphertext = sodium.crypto_aead_chacha20poly1305_ietf_encrypt(
      canonicalBytes(payload),
      aad,
      null,
      nonce,
      this.txKey
    );
    return {
      type: "secure",
      seq,
      ciphertext: bytesToBase64Url(ciphertext),
    };
  }

  decrypt(envelope: Record<string, any>): Record<string, any> {
    if (envelope.type !== "secure") {
      throw new Error("Expected a secure control frame");
    }
    const seq = Number(envelope.seq);
    if (seq !== this.rxSeq) {
      if (seq === this.rxSeq + 1) {
        this.rxSeq = seq;
      } else {
        throw new Error("Control sequence mismatch");
      }
    }
    this.rxSeq += 1;
    const nonce = nonceFromSeq(seq);
    const aad = canonicalBytes({ seq, type: "secure" });
    const plaintext = sodium.crypto_aead_chacha20poly1305_ietf_decrypt(
      null,
      base64UrlToBytes(String(envelope.ciphertext)),
      aad,
      nonce,
      this.rxKey,
      "uint8array"
    );
    return JSON.parse(textDecoder.decode(plaintext));
  }
}

class SecretStreamChannel {
  readonly clientHeader: Uint8Array;
  private txSeq = 0;
  private rxSeq = 0;
  private readonly aadPrefix: Uint8Array;
  private readonly pushState: any;
  private readonly pullState: any;

  constructor(
    txKey: Uint8Array,
    rxKey: Uint8Array,
    serverHeader: Uint8Array,
    aadPrefix: Uint8Array
  ) {
    this.aadPrefix = aadPrefix;
    const push = sodium.crypto_secretstream_xchacha20poly1305_init_push(txKey);
    this.pushState = push.state;
    this.clientHeader = toUint8Array(push.header);
    this.pullState = sodium.crypto_secretstream_xchacha20poly1305_init_pull(serverHeader, rxKey);
  }

  encrypt(payload: Uint8Array): Uint8Array {
    const ciphertext = sodium.crypto_secretstream_xchacha20poly1305_push(
      this.pushState,
      payload,
      this.aad(this.txSeq++),
      sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE
    );
    return toUint8Array(ciphertext);
  }

  decrypt(ciphertext: ArrayBuffer | Uint8Array): Uint8Array {
    const result = sodium.crypto_secretstream_xchacha20poly1305_pull(
      this.pullState,
      toUint8Array(ciphertext),
      this.aad(this.rxSeq++)
    );
    if (!result) {
      throw new Error("Invalid secretstream frame");
    }
    return toUint8Array(result.message);
  }

  private aad(seq: number): Uint8Array {
    const trailer = new Uint8Array(8);
    new DataView(trailer.buffer).setBigUint64(0, BigInt(seq), false);
    return concatBytes(this.aadPrefix, trailer);
  }
}

async function deriveHandshake(
  url: string,
  kind: "control" | "resume",
  channel: string,
  extra: Record<string, any> = {}
) {
  await sodium.ready;
  const ws = new WebSocket(url);
  await waitForOpen(ws);

  const keyPair = sodium.crypto_kx_keypair();
  const clientHello = {
    type: "client_hello",
    kind,
    channel,
    version: PROTOCOL_VERSION,
    timestamp: Date.now(),
    client_nonce: bytesToBase64Url(sodium.randombytes_buf(32)),
    client_kx_pub: bytesToBase64Url(toUint8Array(keyPair.publicKey)),
    ...extra,
  };
  ws.send(JSON.stringify(clientHello));

  const serverHello = requireServerHello(await waitForJsonMessage(ws));
  const pinnedKey = base64UrlToBytes(DEFAULT_SERVER_SIGN_PUBLIC_KEY_B64);
  if (serverHello.server_sign_pub !== DEFAULT_SERVER_SIGN_PUBLIC_KEY_B64) {
    throw new Error("Server signing key does not match the pinned public key");
  }
  const serverCore = {
    type: serverHello.type,
    kind: serverHello.kind,
    channel: serverHello.channel,
    version: serverHello.version,
    initialized: serverHello.initialized,
    pwd_epoch: serverHello.pwd_epoch,
    pwd_salt: serverHello.pwd_salt,
    argon2: serverHello.argon2,
    server_nonce: serverHello.server_nonce,
    server_kx_pub: serverHello.server_kx_pub,
  };
  const transcript = canonicalBytes({
    kind,
    channel,
    client: clientHello,
    server: serverCore,
  });
  const isValid = sodium.crypto_sign_verify_detached(
    base64UrlToBytes(serverHello.signature),
    transcript,
    pinnedKey
  );
  if (!isValid) {
    throw new Error("Server identity verification failed");
  }

  const sharedKey = toUint8Array(
    sodium.crypto_scalarmult(
      toUint8Array(keyPair.privateKey),
      base64UrlToBytes(serverHello.server_kx_pub)
    )
  );
  const transcriptHash = await sha256(transcript);
  const preauthChannel = new JsonSecureChannel(
    await hkdfSha256(sharedKey, textEncoder.encode("preauth:server-rx"), 32, transcriptHash),
    await hkdfSha256(sharedKey, textEncoder.encode("preauth:server-tx"), 32, transcriptHash)
  );

  return {
    ws,
    serverHello,
    sharedKey,
    transcriptHash,
    preauthChannel,
  };
}

async function derivePasswordKey(
  password: string,
  saltB64: string,
  params: Argon2Params
): Promise<Uint8Array> {
  return toUint8Array(
    sodium.crypto_pwhash(
      params.hash_bytes,
      password,
      base64UrlToBytes(saltB64),
      params.opslimit,
      params.memlimit,
      sodium.crypto_pwhash_ALG_ARGON2ID13,
      "uint8array"
    )
  );
}

export class ControlConnection {
  readonly ws: WebSocket;
  readonly initialized: boolean;
  readonly pwdEpoch: number;
  readonly argon2: Argon2Params;
  readonly pwdSalt: string | null;
  public onSecureMessage?: (payload: Record<string, any>) => void;
  public onClose?: (event: CloseEvent) => void;
  public onError?: (event: Event) => void;
  private readonly sharedKey: Uint8Array;
  private readonly transcriptHash: Uint8Array;
  private readonly preauthChannel: JsonSecureChannel;
  private controlChannel: JsonSecureChannel | null = null;
  private session: ControlSessionBundle | null = null;

  private constructor(args: {
    ws: WebSocket;
    initialized: boolean;
    pwdEpoch: number;
    argon2: Argon2Params;
    pwdSalt: string | null;
    sharedKey: Uint8Array;
    transcriptHash: Uint8Array;
    preauthChannel: JsonSecureChannel;
  }) {
    this.ws = args.ws;
    this.initialized = args.initialized;
    this.pwdEpoch = args.pwdEpoch;
    this.argon2 = args.argon2;
    this.pwdSalt = args.pwdSalt;
    this.sharedKey = args.sharedKey;
    this.transcriptHash = args.transcriptHash;
    this.preauthChannel = args.preauthChannel;
  }

  static async open(url: string): Promise<ControlConnection> {
    const handshake = await deriveHandshake(url, "control", "control");
    return new ControlConnection({
      ws: handshake.ws,
      initialized: handshake.serverHello.initialized,
      pwdEpoch: handshake.serverHello.pwd_epoch,
      argon2: handshake.serverHello.argon2,
      pwdSalt: handshake.serverHello.pwd_salt,
      sharedKey: handshake.sharedKey,
      transcriptHash: handshake.transcriptHash,
      preauthChannel: handshake.preauthChannel,
    });
  }

  async resumeWithCookie(): Promise<ControlSessionBundle | null> {
    this.ws.send(JSON.stringify(this.preauthChannel.encrypt({ type: "resume_control" })));
    const payload = this.preauthChannel.decrypt(await waitForJsonMessage(this.ws));
    if (payload.type === "resume_unavailable") {
      return null;
    }
    if (payload.type !== "auth_ok") {
      throw new Error("Expected auth_ok from remembered control session");
    }
    const masterSecret = base64UrlToBytes(String(payload.master_secret || ""));
    const resumeSecret = base64UrlToBytes(String(payload.resume_secret || ""));
    if (masterSecret.length !== 32 || resumeSecret.length !== 32) {
      throw new Error("Remembered control session did not provide session secrets");
    }
    return this.establishSession(payload, masterSecret, resumeSecret, "remember");
  }

  async authenticate(password: string): Promise<ControlSessionBundle> {
    if (!this.initialized) {
      this.ws.send(JSON.stringify(this.preauthChannel.encrypt({ type: "initialize", password })));
    } else {
      if (!this.pwdSalt) {
        throw new Error("Server did not provide a password salt");
      }
      const pwKey = await derivePasswordKey(password, this.pwdSalt, this.argon2);
      const authContext = await hkdfSha256(
        this.sharedKey,
        textEncoder.encode(`auth-proof:${this.pwdEpoch}`),
        32,
        this.transcriptHash
      );
      const proof = toUint8Array(sodium.crypto_auth_hmacsha256(authContext, pwKey));
      this.ws.send(
        JSON.stringify(
          this.preauthChannel.encrypt({
            type: "authenticate",
            proof: bytesToBase64Url(proof),
          })
        )
      );
    }

    const authOk = this.preauthChannel.decrypt(await waitForJsonMessage(this.ws));
    if (authOk.type !== "auth_ok") {
      throw new Error("Expected auth_ok from control server");
    }
    const sessionPwdKey = await derivePasswordKey(
      password,
      String(authOk.pwd_salt),
      authOk.argon2 as Argon2Params
    );
    const masterSecret = await hkdfSha256(
      concatBytes(this.sharedKey, sessionPwdKey),
      textEncoder.encode("master-secret"),
      32,
      this.transcriptHash
    );
    const resumeSecret = await hkdfSha256(
      masterSecret,
      textEncoder.encode("resume-secret"),
      32,
      this.transcriptHash
    );
    return this.establishSession(authOk, masterSecret, resumeSecret, "password");
  }

  private async establishSession(
    authOk: Record<string, any>,
    masterSecret: Uint8Array,
    resumeSecret: Uint8Array,
    authMode: "password" | "remember"
  ): Promise<ControlSessionBundle> {
    const sessionId = String(authOk.session_id);
    const controlSalt = await sha256(textEncoder.encode(sessionId));
    this.controlChannel = new JsonSecureChannel(
      await hkdfSha256(masterSecret, textEncoder.encode("control:server-rx"), 32, controlSalt),
      await hkdfSha256(masterSecret, textEncoder.encode("control:server-tx"), 32, controlSalt)
    );
    this.session = {
      sessionId,
      resumeTicket: String(authOk.resume_ticket),
      pwdEpoch: Number(authOk.pwd_epoch),
      expiresAt: Number(authOk.expires_at),
      masterSecret,
      resumeSecret,
      authMode,
    };
    this.bindControlHandlers();
    return this.session;
  }

  // send(payload: Record<string, any>): void {
  //   if (!this.controlChannel) {
  //     throw new Error("Control websocket is not authenticated");
  //   }
  //   this.ws.send(JSON.stringify(this.controlChannel.encrypt(payload)));
  // }

  close(): void {
    this.ws.close();
  }

  private bindControlHandlers(): void {
    if (!this.controlChannel) return;
    this.ws.onmessage = (event) => {
      try {
        if (typeof event.data !== "string") return;
        const securePayload = JSON.parse(event.data) as Record<string, any>;
        const payload = this.controlChannel!.decrypt(securePayload);
        this.onSecureMessage?.(payload);
      } catch (error) {
        console.error("[control] Failed to decrypt control frame", error);
      }
    };
    this.ws.onclose = (event) => {
      this.onClose?.(event);
    };
    this.ws.onerror = (event) => {
      this.onError?.(event);
    };
  }
}

const fillRandom = (buf: Uint8Array): Uint8Array => {
  if (globalThis.crypto?.getRandomValues) {
    return globalThis.crypto.getRandomValues(buf);
  }
  let x = Date.now();
  for (let i = 0; i < buf.length; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    buf[i] = x & 0xff;
  }
  return buf;
};

export const randomUUID = (): string => {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  fillRandom(bytes);

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const rememberControlSession = async (
  httpBase: string,
  session: ControlSessionBundle
): Promise<void> => {
  await sodium.ready;
  const proofContext = canonicalBytes({
    type: "remember_session",
    session_id: session.sessionId,
    pwd_epoch: session.pwdEpoch,
  });
  const proof = toUint8Array(sodium.crypto_auth_hmacsha256(proofContext, session.resumeSecret));
  const response = await fetch(`${httpBase}/auth/remember`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      session_id: session.sessionId,
      proof: bytesToBase64Url(proof),
    }),
  });
  if (!response.ok) {
    throw new Error((await response.text()) || "Failed to persist authenticated session");
  }
};

export class SecureWebSocket {
  public onOpen?: (event: Event) => void;
  public onClose?: (event: CloseEvent) => void;
  public onError?: (event: Event) => void;
  public hookClose?: () => void;
  private readonly url: string;
  private readonly name: string;
  private readonly session: ControlSessionBundle;
  private readonly binaryType: BinaryType | null;
  private ws: WebSocket | null = null;
  private stream: SecretStreamChannel | null = null;
  private socketId = randomUUID();
  private readonly channelName: string;

  constructor(
    url: string,
    name: string,
    session: ControlSessionBundle,
    binaryType: BinaryType | null = null
  ) {
    this.url = url;
    this.name = name;
    this.session = session;
    this.binaryType = binaryType;
    this.channelName = name.startsWith("remote-") ? "remote" : name;
  }

  get readyState(): number | undefined {
    return this.ws?.readyState;
  }

  async connect(onMessage?: (msg: any) => void, decodeJson = true, decrypt = true): Promise<void> {
    const handshake = await deriveHandshake(this.url, "resume", this.channelName, {
      session_id: this.session.sessionId,
      socket_id: this.socketId,
      resume_ticket: this.session.resumeTicket,
    });
    const resumeContext = canonicalBytes({
      transcript_hash: bytesToBase64Url(handshake.transcriptHash),
      session_id: this.session.sessionId,
      socket_id: this.socketId,
      channel: this.channelName,
      pwd_epoch: this.session.pwdEpoch,
    });
    const resumeMac = toUint8Array(
      sodium.crypto_auth_hmacsha256(resumeContext, this.session.resumeSecret)
    );
    handshake.ws.send(
      JSON.stringify(
        handshake.preauthChannel.encrypt({
          type: "resume_proof",
          resume_mac: bytesToBase64Url(resumeMac),
        })
      )
    );

    const resumeOk = handshake.preauthChannel.decrypt(await waitForJsonMessage(handshake.ws));
    if (resumeOk.type !== "resume_ok") {
      throw new Error("Expected resume_ok from business websocket");
    }

    const scopeBytes = canonicalBytes({
      scope: "ws",
      session_id: this.session.sessionId,
      socket_id: this.socketId,
      channel: this.channelName,
      pwd_epoch: this.session.pwdEpoch,
    });
    const base = await hkdfSha256(
      this.session.masterSecret,
      scopeBytes,
      64,
      handshake.transcriptHash
    );
    const serverTxKey = await hkdfSha256(
      base.slice(0, 32),
      textEncoder.encode("secretstream:server-tx"),
      32,
      handshake.transcriptHash
    );
    const clientTxKey = await hkdfSha256(
      base.slice(32),
      textEncoder.encode("secretstream:server-rx"),
      32,
      handshake.transcriptHash
    );
    this.stream = new SecretStreamChannel(
      clientTxKey,
      serverTxKey,
      base64UrlToBytes(String(resumeOk.server_header)),
      canonicalBytes({
        session_id: this.session.sessionId,
        socket_id: this.socketId,
        channel: this.channelName,
        pwd_epoch: this.session.pwdEpoch,
      })
    );

    handshake.ws.send(
      JSON.stringify(
        handshake.preauthChannel.encrypt({
          type: "stream_ready",
          client_header: bytesToBase64Url(this.stream.clientHeader),
        })
      )
    );

    this.ws = handshake.ws;
    if (this.binaryType !== null) {
      this.ws.binaryType = this.binaryType;
    }
    this.ws.onopen = (event) => {
      this.onOpen?.(event);
    };
    this.ws.onclose = (event) => {
      this.onClose?.(event);
      this.hookClose?.();
    };
    this.ws.onerror = (event) => {
      this.onError?.(event);
    };
    this.ws.onmessage = (event) => {
      try {
        const ciphertext =
          event.data instanceof ArrayBuffer
            ? new Uint8Array(event.data)
            : new Uint8Array(event.data as ArrayBufferLike);

        const plaintext = decrypt ? this.stream!.decrypt(ciphertext) : ciphertext;
        if (decodeJson) {
          const decoded = JSON.parse(textDecoder.decode(plaintext));
          // console.log(`${this.name} Recv: ${textDecoder.decode(plaintext)}`);
          onMessage?.(decoded);
        } else {
          onMessage?.(
            plaintext.buffer.slice(
              plaintext.byteOffset,
              plaintext.byteOffset + plaintext.byteLength
            )
          );
        }
      } catch (error) {
        console.error(`[${this.name}] Failed to decrypt websocket frame`, error);
      }
    };
    this.onOpen?.(new Event("open"));
  }

  sendJson(payload: Record<string, any>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.stream) {
      throw new Error("WebSocket stream is not ready");
    }
    const ciphertext = this.stream.encrypt(textEncoder.encode(JSON.stringify(payload)));
    this.ws.send(ciphertext);
  }

  sendBytes(payload: ArrayBuffer | Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.stream) {
      throw new Error("WebSocket stream is not ready");
    }
    const ciphertext = this.stream.encrypt(toUint8Array(payload));
    this.ws.send(ciphertext);
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}

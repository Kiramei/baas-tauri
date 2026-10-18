import type { BackendChannelName } from "@/transport/types";

const HEADER_BYTES = 10;
const MAGIC = [0x42, 0x50, 0x49, 0x50] as const;
const VERSION = 1;
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
const BINARY_REQUEST_HEADER_BYTES = 8;
const encoder = new TextEncoder();
const CHANNEL_IDS: Record<BackendChannelName, number> = {
  provider: 1,
  sync: 2,
  trigger: 3,
  remote: 4,
};

export const KIND_JSON = 1;
export const KIND_BYTES = 2;
export const KIND_CLOSE = 3;
export const KIND_ERROR = 4;

// A callback may contain one frame (older Rust bridge) or a batch. Payload views
// borrow the incoming buffer; JSON decoding does not copy the payload first.
export function* decodeFrames(
  raw: ArrayBuffer | Uint8Array
): Generator<{ kind: number; payload: Uint8Array }> {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  do {
    if (bytes.byteLength - offset < HEADER_BYTES) throw new Error("Truncated named pipe frame");
    if (
      MAGIC.some((value, index) => bytes[offset + index] !== value) ||
      bytes[offset + 4] !== VERSION
    ) {
      throw new Error("Invalid named pipe frame header");
    }
    const kind = bytes[offset + 5];
    if (kind < KIND_JSON || kind > KIND_ERROR) throw new Error("Invalid named pipe frame kind");
    const length = view.getUint32(offset + 6, true);
    if (length > MAX_PAYLOAD_BYTES || length > bytes.byteLength - offset - HEADER_BYTES) {
      throw new Error("Invalid named pipe frame length");
    }
    const end = offset + HEADER_BYTES + length;
    yield { kind, payload: bytes.subarray(offset + HEADER_BYTES, end) };
    offset = end;
  } while (offset < bytes.byteLength);
}

// Raw invoke avoids expanding every byte into a JS number and serializing a JSON
// array. This envelope is only for WebView -> Rust; BPIP remains unchanged.
export function encodeBinaryRequest(
  channel: BackendChannelName,
  name: string,
  payload: ArrayBuffer | Uint8Array
): Uint8Array<ArrayBuffer> {
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const nameBytes = encoder.encode(name);
  if (nameBytes.byteLength > 0xffff)
    throw new Error("Named pipe channel name exceeds 65535 UTF-8 bytes");
  if (bytes.byteLength > MAX_PAYLOAD_BYTES)
    throw new Error("Named pipe payload exceeds the 64 MiB limit");
  const request = new Uint8Array(
    BINARY_REQUEST_HEADER_BYTES + nameBytes.byteLength + bytes.byteLength
  );
  request.set([0x42, 0x50, 0x52, 0x51, VERSION, CHANNEL_IDS[channel]]);
  new DataView(request.buffer).setUint16(6, nameBytes.byteLength, true);
  request.set(nameBytes, BINARY_REQUEST_HEADER_BYTES);
  request.set(bytes, BINARY_REQUEST_HEADER_BYTES + nameBytes.byteLength);
  return request;
}

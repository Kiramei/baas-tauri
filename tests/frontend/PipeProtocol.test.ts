import { describe, expect, test } from "bun:test";
import {
  decodeFrames,
  encodeBinaryRequest,
  KIND_BYTES,
  KIND_CLOSE,
  KIND_JSON,
} from "../../src/transport/pipe/protocol";

const encoder = new TextEncoder();

function frame(kind: number, payload: Uint8Array = new Uint8Array()): Uint8Array {
  const bytes = new Uint8Array(10 + payload.byteLength);
  bytes.set([0x42, 0x50, 0x49, 0x50, 1, kind]);
  new DataView(bytes.buffer).setUint32(6, payload.byteLength, true);
  bytes.set(payload, 10);
  return bytes;
}

function join(...frames: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(frames.reduce((total, value) => total + value.byteLength, 0));
  let offset = 0;
  for (const value of frames) {
    bytes.set(value, offset);
    offset += value.byteLength;
  }
  return bytes;
}

describe("pipe WebView protocol", () => {
  test("decodes both legacy single frames and ordered mixed batches without copying", () => {
    const first = frame(KIND_JSON, encoder.encode('{"name":"配置"}'));
    const second = frame(KIND_BYTES, new Uint8Array([0, 255, 4]));
    const batch = join(first, second, frame(KIND_CLOSE));
    const values = [...decodeFrames(batch)];
    expect(values.map(({ kind }) => kind)).toEqual([KIND_JSON, KIND_BYTES, KIND_CLOSE]);
    expect(new TextDecoder().decode(values[0].payload)).toBe('{"name":"配置"}');
    expect(values[1].payload).toEqual(new Uint8Array([0, 255, 4]));
    expect(values[1].payload.buffer).toBe(batch.buffer);
    expect([...decodeFrames(first.buffer)]).toHaveLength(1);
  });

  test("respects sliced input offsets and rejects incomplete or corrupt batches", () => {
    const valid = frame(KIND_BYTES, new Uint8Array([1, 2, 3]));
    const padded = join(new Uint8Array([99, 99]), valid, new Uint8Array([99]));
    expect([...decodeFrames(padded.subarray(2, -1))][0].payload).toEqual(new Uint8Array([1, 2, 3]));
    for (let end = 0; end < valid.length; end++) {
      expect(() => [...decodeFrames(valid.subarray(0, end))]).toThrow();
    }
    const corrupt = valid.slice();
    corrupt[0] = 0;
    expect(() => [...decodeFrames(join(valid, corrupt))]).toThrow("header");
    corrupt.set(valid);
    corrupt[5] = 9;
    expect(() => [...decodeFrames(corrupt)]).toThrow("kind");
  });

  test("encodes UTF-8 routing and only the selected binary bytes as raw IPC", () => {
    const payload = new Uint8Array([99, 0, 255, 7, 99]);
    const encoded = encodeBinaryRequest("remote", "remote-配置", payload.subarray(1, -1));
    expect([...encoded.subarray(0, 6)]).toEqual([0x42, 0x50, 0x52, 0x51, 1, 4]);
    const length = new DataView(encoded.buffer).getUint16(6, true);
    expect(new TextDecoder().decode(encoded.subarray(8, 8 + length))).toBe("remote-配置");
    expect(encoded.subarray(8 + length)).toEqual(new Uint8Array([0, 255, 7]));
    expect(() => encodeBinaryRequest("remote", "配".repeat(22_000), payload)).toThrow("65535");
  });
});

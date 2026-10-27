import assert from "node:assert/strict";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

Object.assign(globalThis, { __WITH_TAURI__: true, __WITH_ANDROID__: true });
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { crypto: globalThis.crypto },
});
const { default: StorageUtil } = await import("../../../src/shared/StorageManager");
const destination = "content://com.android.providers.downloads.documents/document/83";
const zip = new Uint8Array([80, 75, 3, 4, 0, 255]);
const writes: { bytes: number[]; options: any }[] = [];
let selected: string | null = destination;
let failure: string | undefined = undefined;
let finishWrite: (() => void) | undefined;
let notifyWriteStarted!: () => void;
const writeStarted = new Promise<void>((resolve) => { notifyWriteStarted = resolve; });

mockIPC((command, args) => {
  if (command === "plugin:dialog|save") return selected;
  if (command === "plugin:fs|write_file") {
    const bytes = Array.from(args as Uint8Array);
    // Android postMessage turns the nested Uint8Array into this JSON array;
    // plugin-fs write_file_inner explicitly accepts that shape.
    assert.deepEqual(JSON.parse(JSON.stringify(bytes)), Array.from(zip));
    if (failure) return Promise.reject(failure);
    return new Promise<void>((resolve) => {
      finishWrite = resolve;
      notifyWriteStarted();
    });
  }
});
const internals = (window as any).__TAURI_INTERNALS__;
const originalInvoke = internals.invoke;
internals.invoke = (command: string, args: unknown, options: unknown) => {
  if (command === "plugin:fs|write_file")
    writes.push({ bytes: Array.from(args as Uint8Array), options });
  return originalInvoke(command, args, options);
};
const translate = ((key: string) => key) as any;
let saved = false;
const pending = StorageUtil.download("安卓免费日常.zip", zip.buffer, translate).then(() => {
  saved = true;
});
// Wait for the actual IPC boundary, not a fixed number of millisecond sleeps:
// cold dynamic imports can be slower while the Android build is doing disk I/O.
let startDeadline: ReturnType<typeof setTimeout> | undefined;
try {
  await Promise.race([
    writeStarted,
    pending.then(() => assert.ok(finishWrite, "download completed without starting a write")),
    new Promise<never>((_resolve, reject) => {
      startDeadline = setTimeout(() => reject(new Error("download never reached the file writer")), 5_000);
    }),
  ]);
} finally {
  clearTimeout(startDeadline);
}
assert.equal(writes.length, 1);
assert.equal(saved, false, "download must not report completion before the write finishes");
assert.deepEqual(writes[0].bytes, Array.from(zip));
assert.equal(decodeURIComponent(writes[0].options.headers.path), destination);
finishWrite!();
await pending;
assert.equal(saved, true);

selected = null;
await StorageUtil.download("cancelled.zip", zip, translate);
assert.equal(writes.length, 1, "cancelling the SAF picker cannot write a file");
selected = destination;
failure = "fs.write_file not allowed";
await assert.rejects(
  StorageUtil.download("denied.zip", zip, translate),
  (error) => error === failure
);
clearMocks();
console.log("Android StorageManager download regression passed");

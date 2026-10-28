import assert from "node:assert/strict";
import { toast } from "sonner";

Object.assign(globalThis, { __WITH_TAURI__: false, __WITH_ANDROID__: false });
const values = new Map<string, string>();
let rejectWrites = false;
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (rejectWrites) throw new DOMException("Site storage is full", "QuotaExceededError");
      values.set(key, value);
    },
  },
});
const { createUISettingsStore } = await import("../../../src/context/UISettingsProvider");
const store = createUISettingsStore();
let notifications = 0;
store.subscribe(() => {
  notifications += 1;
});
store.set((settings) => ({ ...settings, lang: "zh", theme: "dark", zoomScale: 125 }));
const saved = values.get("uiSettings");
const previous = store.getSnapshot();
const previousToasts = toast.getHistory().length;

rejectWrites = true;
store.set((settings) => ({ ...settings, backgroundImageBase64: "data:image/png;base64,large" }));
assert.equal(store.getSnapshot(), previous, "a rejected image must leave the UI snapshot intact");
assert.equal(
  values.get("uiSettings"),
  saved,
  "a rejected image must not replace saved preferences"
);
assert.equal(notifications, 1, "a rejected write must not publish a misleading change");
assert.equal(toast.getHistory().length, previousToasts + 1, "storage failure must be visible");

rejectWrites = false;
store.set((settings) => ({ ...settings, assetsDisplay: false }));
assert.equal(notifications, 2);
const recovered = JSON.parse(values.get("uiSettings")!);
assert.equal(recovered.lang, "zh");
assert.equal(recovered.theme, "dark");
assert.equal(recovered.zoomScale, 125);
assert.equal(recovered.backgroundImageBase64, null);
assert.equal(recovered.assetsDisplay, false);
console.log("Browser UI settings persistence regression passed");

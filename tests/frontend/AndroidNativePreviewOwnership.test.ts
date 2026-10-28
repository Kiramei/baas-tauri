import { describe, expect, test } from "bun:test";
import { AndroidNativePreviewOwnership } from "../../src/shared/AndroidNativePreviewOwnership";

describe("Android native preview with cached Home pages", () => {
  test("a hidden cached page cannot disable the visible page's preview", () => {
    const preview = new AndroidNativePreviewOwnership();
    const visible = {};
    const cached = {};
    preview.acquire(visible);
    for (let poll = 0; poll < 3; poll += 1) {
      expect(preview.release(cached)).toBe(false);
      expect(preview.owns(visible)).toBe(true);
    }
  });

  test("old-page cleanup cannot close a new page that claimed the native host first", () => {
    const preview = new AndroidNativePreviewOwnership();
    const previous = {};
    const current = {};
    preview.acquire(previous);
    preview.acquire(current);
    expect(preview.release(previous)).toBe(false);
    expect(preview.owns(current)).toBe(true);
    expect(preview.release(current)).toBe(true);
  });

  test("leaving Home closes the host once and a later visit can resume it", () => {
    const preview = new AndroidNativePreviewOwnership();
    const home = {};
    preview.acquire(home);
    expect(preview.release(home)).toBe(true);
    expect(preview.release(home)).toBe(false);
    expect(preview.release(home)).toBe(false);
    preview.acquire(home);
    expect(preview.owns(home)).toBe(true);
    expect(preview.release(home)).toBe(true);
  });
});

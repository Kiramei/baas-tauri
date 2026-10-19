import { describe, expect, test } from "bun:test";
import { settingsSearchClipBounds } from "../../src/shared/SettingsSearchClipping";

type Style = Pick<CSSStyleDeclaration, "display" | "overflowX" | "overflowY">;
const styles = new WeakMap<Element, Style>();

function box(
  rect: { left: number; top: number; width: number; height: number },
  style: Partial<Style> = {},
  parentElement: Element | null = null,
  client: Partial<Pick<HTMLElement, "clientLeft" | "clientTop" | "clientWidth" | "clientHeight" | "offsetWidth" | "offsetHeight">> = {}
) {
  const element = {
    parentElement,
    clientLeft: 0,
    clientTop: 0,
    clientWidth: rect.width,
    clientHeight: rect.height,
    offsetWidth: rect.width,
    offsetHeight: rect.height,
    getBoundingClientRect: () => rect,
    ...client,
  } as Element;
  styles.set(element, { display: "block", overflowX: "visible", overflowY: "visible", ...style });
  return element;
}

const getStyle = (element: Element) => styles.get(element)!;

describe("settings search fallback clipping", () => {
  test("nested vertical scroll and horizontal ellipsis clip on their own axes", () => {
    const page = box({ left: 80, top: 40, width: 700, height: 500 }, { overflowY: "auto" });
    const table = box({ left: 100, top: 200, width: 620, height: 180 }, { overflowY: "scroll" }, page);
    const label = box({ left: 120, top: 220, width: 160, height: 20 }, { overflowX: "hidden" }, table);
    expect(settingsSearchClipBounds(label, 1000, 800, getStyle)).toEqual({
      left: 120, right: 280, top: 200, bottom: 380,
    });
  });

  test("client boundaries exclude borders and scrollbars even when scaled", () => {
    const table = box(
      { left: 10, top: 20, width: 400, height: 240 },
      { overflowX: "auto", overflowY: "auto" },
      null,
      { clientLeft: 2, clientTop: 3, clientWidth: 180, clientHeight: 100, offsetWidth: 200, offsetHeight: 120 }
    );
    expect(settingsSearchClipBounds(table, 1000, 800, getStyle)).toEqual({
      left: 14, right: 374, top: 26, bottom: 226,
    });
  });

  test("viewport remains a boundary and a fully offscreen inner scroller is empty", () => {
    const offscreen = box({ left: 200, top: 900, width: 300, height: 100 }, { overflowY: "clip" });
    const clip = settingsSearchClipBounds(offscreen, 600, 800, getStyle);
    expect(clip).toEqual({ left: 0, right: 600, top: 900, bottom: 800 });
    expect(clip.bottom <= clip.top).toBe(true);
  });

  test("visible overflow and inline boxes do not hide otherwise visible text", () => {
    const parent = box({ left: 20, top: 30, width: 50, height: 20 });
    const inline = box(
      { left: 25, top: 30, width: 30, height: 20 },
      { display: "inline", overflowX: "hidden", overflowY: "hidden" },
      parent,
      { clientWidth: 0, clientHeight: 0 }
    );
    expect(settingsSearchClipBounds(inline, 600, 800, getStyle)).toEqual({
      left: 0, right: 600, top: 0, bottom: 800,
    });
  });
});

import { describe, expect, test } from "bun:test";
import { clipToSearchViewport, searchViewportBounds } from "../../src/shared/SearchViewport";

describe("search viewport clipping", () => {
  test("desktop and WebViews without visualViewport retain layout coordinates", () => {
    expect(searchViewportBounds(1280, 720)).toEqual({ left: 0, top: 0, right: 1280, bottom: 720 });
    expect(searchViewportBounds(393, 800, null)).toEqual({
      left: 0,
      top: 0,
      right: 393,
      bottom: 800,
    });
  });

  test("the keyboard limits results to the remaining visual viewport", () => {
    const viewport = searchViewportBounds(393, 800, {
      offsetLeft: 0,
      offsetTop: 0,
      width: 393,
      height: 360,
    });
    expect(clipToSearchViewport({ left: 12, right: 381, top: 110, bottom: 740 }, viewport)).toEqual(
      { left: 12, right: 381, top: 110, bottom: 360 }
    );
  });

  test("panned visual viewports keep the layout origin for mask holes and text ranges", () => {
    const viewport = searchViewportBounds(400, 800, {
      offsetLeft: 10,
      offsetTop: 120,
      width: 380,
      height: 320,
    });
    expect(viewport).toEqual({ left: 10, right: 390, top: 120, bottom: 440 });
    const clip = clipToSearchViewport({ left: 0, right: 400, top: 60, bottom: 700 }, viewport);
    expect(clip).toEqual(viewport);
    expect({ x: clip.left - viewport.left, y: clip.top - viewport.top }).toEqual({ x: 0, y: 0 });
  });

  test("a result behind the keyboard stays empty instead of opening a spotlight", () => {
    const clip = clipToSearchViewport(
      { left: 12, right: 381, top: 500, bottom: 550 },
      { left: 0, right: 393, top: 0, bottom: 360 }
    );
    expect(clip.bottom <= clip.top).toBe(true);
  });

  test("transient empty viewports during rotation use the layout fallback", () => {
    expect(
      searchViewportBounds(800, 393, {
        offsetLeft: 0,
        offsetTop: 0,
        width: 0,
        height: 0,
      })
    ).toEqual({ left: 0, top: 0, right: 800, bottom: 393 });
  });
});

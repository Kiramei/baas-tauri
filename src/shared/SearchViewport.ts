import type { SettingsSearchClip } from "./SettingsSearchClipping";

type VisibleViewport = Pick<VisualViewport, "offsetLeft" | "offsetTop" | "width" | "height">;

/** Layout coordinates of the area still visible above a mobile keyboard. */
export function searchViewportBounds(
  width: number,
  height: number,
  visualViewport?: VisibleViewport | null
): SettingsSearchClip {
  if (!visualViewport || visualViewport.width <= 0 || visualViewport.height <= 0) {
    return { left: 0, top: 0, right: width, bottom: height };
  }
  return {
    left: visualViewport.offsetLeft,
    top: visualViewport.offsetTop,
    right: visualViewport.offsetLeft + visualViewport.width,
    bottom: visualViewport.offsetTop + visualViewport.height,
  };
}

export function clipToSearchViewport(
  clip: SettingsSearchClip,
  viewport: SettingsSearchClip
): SettingsSearchClip {
  return {
    left: Math.max(clip.left, viewport.left),
    right: Math.min(clip.right, viewport.right),
    top: Math.max(clip.top, viewport.top),
    bottom: Math.min(clip.bottom, viewport.bottom),
  };
}

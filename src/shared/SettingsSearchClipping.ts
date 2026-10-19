export interface SettingsSearchClip {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

type OverflowStyle = Pick<CSSStyleDeclaration, "display" | "overflowX" | "overflowY">;
const clipsOverflow = (value: string) => /^(auto|scroll|hidden|clip)$/.test(value);

/** Viewport coordinates for the visible client area of a text node's ancestors. */
export function settingsSearchClipBounds(
  parent: Element | null,
  viewportWidth: number,
  viewportHeight: number,
  getStyle: (element: Element) => OverflowStyle
): SettingsSearchClip {
  const clip = { left: 0, right: viewportWidth, top: 0, bottom: viewportHeight };
  for (let element = parent; element; element = element.parentElement) {
    const style = getStyle(element);
    // Overflow does not clip non-replaced inline boxes or display:contents.
    if (style.display === "inline" || style.display === "contents") continue;
    const clipX = clipsOverflow(style.overflowX);
    const clipY = clipsOverflow(style.overflowY);
    if (!clipX && !clipY) continue;
    const rect = element.getBoundingClientRect();
    const box = element as HTMLElement;
    const scaleX = box.offsetWidth ? rect.width / box.offsetWidth : 1;
    const scaleY = box.offsetHeight ? rect.height / box.offsetHeight : 1;
    const left = rect.left + element.clientLeft * scaleX;
    const top = rect.top + element.clientTop * scaleY;
    if (clipX) {
      clip.left = Math.max(clip.left, left);
      clip.right = Math.min(clip.right, left + element.clientWidth * scaleX);
    }
    if (clipY) {
      clip.top = Math.max(clip.top, top);
      clip.bottom = Math.min(clip.bottom, top + element.clientHeight * scaleY);
    }
  }
  return clip;
}

import { useEffect, type RefObject } from "react";
import { findSettingsSearchMatches } from "./SettingsSearch";
import { settingsSearchClipBounds, type SettingsSearchClip } from "./SettingsSearchClipping";
import { clipToSearchViewport, searchViewportBounds } from "./SearchViewport";
import { resolveConfigurationSearchTab } from "./ConfigurationSections";
import { useAppTranslation } from "./useAppTranslation";
import "./settings-search.css";
import "./configuration-search.css";

const NAME = "baas-configuration-search";
const ACTIVE_NAME = "baas-configuration-search-active";
const SVG_NS = "http://www.w3.org/2000/svg";
let highlightOwner: object | null = null;
let maskSequence = 0;

type HighlightWindow = Window & {
  CSS?: {
    highlights?: { set(name: string, highlight: unknown): void; delete(name: string): void };
  };
  Highlight?: new (...ranges: Range[]) => unknown;
};

/** Search uses the same clipped spotlight as Settings without replacing React-owned text. */
export function useConfigurationSearchHighlight(
  pageRef: RefObject<HTMLElement | null>,
  section: string,
  query: string,
  language: string
) {
  const { t } = useAppTranslation();
  useEffect(() => {
    const root = pageRef.current;
    const document = root?.ownerDocument;
    const view = document?.defaultView as HighlightWindow | null;
    if (!root || !document || !view) return;
    const owner = {};
    const maskId = `configuration-search-mask-${++maskSequence}`;
    const registry = view.CSS?.highlights;
    const Highlight = view.Highlight;
    let overlay: HTMLDivElement | null = null;
    let frame = 0;
    let activeIndex = 0;
    let matchCount = 0;
    let selectionRevision = 0;
    let lastScrollKey = "";
    let tabResolved = false;
    let disposed = false;
    let windowFocused = true;
    const clear = () => {
      if (highlightOwner === owner) {
        registry?.delete(NAME);
        registry?.delete(ACTIVE_NAME);
        highlightOwner = null;
      }
      overlay?.remove();
      overlay = null;
    };
    const focusedSearch = () => {
      const input = document.activeElement as HTMLInputElement | null;
      return windowFocused &&
        query.trim() &&
        input?.matches("[data-configuration-search]") &&
        input.value === query &&
        input.getClientRects().length &&
        root.getClientRects().length &&
        !root.closest("[aria-hidden='true']")
        ? input
        : null;
    };
    const viewportBounds = () =>
      searchViewportBounds(
        view.innerWidth,
        view.innerHeight,
        __WITH_ANDROID__ ? view.visualViewport : null
      );
    const clipBounds = (element: Element | null) =>
      clipToSearchViewport(
        settingsSearchClipBounds(element, view.innerWidth, view.innerHeight, (parent) =>
          view.getComputedStyle(parent)
        ),
        viewportBounds()
      );
    const intersect = (rect: DOMRect, clip: SettingsSearchClip, padding = 0) => ({
      left: Math.max(clip.left, rect.left - padding),
      right: Math.min(clip.right, rect.right + padding),
      top: Math.max(clip.top, rect.top - padding),
      bottom: Math.min(clip.bottom, rect.bottom + padding),
    });
    const reveal = (range: Range, input: HTMLElement) => {
      const viewport = viewportBounds();
      const scrollRegion = root.closest<HTMLElement>(".app-page-scroll, .android-page-scroll");
      for (
        let element = range.startContainer.parentElement;
        element;
        element = element.parentElement
      ) {
        const style = view.getComputedStyle(element);
        if (/(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight) {
          const box = element.getBoundingClientRect();
          const scaleY = element.offsetHeight ? box.height / element.offsetHeight : 1;
          const inputBottom =
            element === scrollRegion && element.contains(input)
              ? (__WITH_ANDROID__
                  ? (input.closest(".configuration-compact-navigation") ?? input)
                  : input
                ).getBoundingClientRect().bottom + 16
              : 0;
          const contentTop = Math.max(box.top + element.clientTop * scaleY + 16, inputBottom);
          const top = __WITH_ANDROID__ ? Math.max(contentTop, viewport.top + 16) : contentTop;
          const bottom =
            (__WITH_ANDROID__ ? Math.min(box.bottom, viewport.bottom) : box.bottom) - 16;
          const rect = range.getBoundingClientRect();
          if ((!__WITH_ANDROID__ || bottom > top) && (rect.top < top || rect.bottom > bottom)) {
            element.scrollTop +=
              (rect.top - top - Math.min(96, Math.max(0, bottom - top) * 0.25)) / scaleY;
          }
        }
        if (/(auto|scroll)/.test(style.overflowX) && element.scrollWidth > element.clientWidth) {
          const box = element.getBoundingClientRect();
          const scaleX = element.offsetWidth ? box.width / element.offsetWidth : 1;
          const rect = range.getBoundingClientRect();
          if (rect.left < box.left) element.scrollLeft += (rect.left - box.left) / scaleX;
          else if (rect.right > box.right) element.scrollLeft += (rect.right - box.right) / scaleX;
        }
        if (element === scrollRegion) break;
      }
    };
    const paint = () => {
      frame = 0;
      clear();
      const input = focusedSearch();
      if (disposed || !input) {
        lastScrollKey = "";
        return;
      }
      if (!tabResolved) {
        tabResolved = true;
        const tab = resolveConfigurationSearchTab(section, query, t);
        const trigger = tab
          ? root.querySelector<HTMLButtonElement>(
              `[data-configuration-section="${section}"] [role="tab"][id$="-trigger-${tab}"]`
            )
          : null;
        if (trigger && !trigger.disabled && trigger.dataset.state !== "active") {
          // Radix activates tabs on mouse down; preserve the search input's focus.
          trigger.dispatchEvent(
            new MouseEvent("mousedown", { bubbles: true, button: 0, ctrlKey: false })
          );
          return;
        }
      }
      const ranges: Range[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const parent = node.parentElement;
        if (
          !parent ||
          !parent.getClientRects().length ||
          parent.closest(
            "input,textarea,select,option,script,style,.sr-only,[hidden],[aria-hidden='true'],[data-settings-search-ignore]"
          ) ||
          view.getComputedStyle(parent).visibility === "hidden"
        )
          continue;
        for (const match of findSettingsSearchMatches(node.textContent ?? "", query)) {
          const range = document.createRange();
          range.setStart(node, match.start);
          range.setEnd(node, match.end);
          ranges.push(range);
        }
      }
      matchCount = ranges.length;
      activeIndex = Math.min(activeIndex, Math.max(0, matchCount - 1));
      const active = ranges[activeIndex];
      if (!active) return;
      const scrollKey = `${query}\0${activeIndex}\0${selectionRevision}`;
      if (scrollKey !== lastScrollKey) {
        lastScrollKey = scrollKey;
        reveal(active, input);
      }
      if (registry && Highlight) {
        registry.set(NAME, new Highlight(...ranges));
        registry.set(ACTIVE_NAME, new Highlight(active));
        highlightOwner = owner;
      }
      overlay = document.createElement("div");
      overlay.className = "settings-search-overlays configuration-search-overlays";
      overlay.setAttribute("aria-hidden", "true");
      const viewport = viewportBounds();
      if (__WITH_ANDROID__) {
        overlay.setAttribute("data-native-preview-blocker", "");
        Object.assign(overlay.style, {
          inset: "auto",
          left: `${viewport.left}px`,
          top: `${viewport.top}px`,
          width: `${viewport.right - viewport.left}px`,
          height: `${viewport.bottom - viewport.top}px`,
        });
      }
      overlay.dataset.activeIndex = String(activeIndex);
      overlay.dataset.matchCount = String(matchCount);
      overlay.dataset.activeSection = section;
      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("width", "100%");
      svg.setAttribute("height", "100%");
      const mask = document.createElementNS(SVG_NS, "mask");
      mask.id = maskId;
      mask.setAttribute("maskUnits", "userSpaceOnUse");
      const svgRect = (attributes: Record<string, string>) => {
        const rect = document.createElementNS(SVG_NS, "rect");
        for (const [key, value] of Object.entries(attributes)) rect.setAttribute(key, value);
        return rect;
      };
      mask.appendChild(svgRect({ width: "100%", height: "100%", fill: "white" }));
      const target =
        active.startContainer.parentElement?.closest<HTMLElement>(
          ".settings-row, .settings-block, .stage-plan-section, .sweep-plan-row, .shop-goods-item, tr, .settings-group-title, .configuration-detail-heading"
        ) ?? active.startContainer.parentElement!;
      for (const [element, padding] of [
        [target, 5],
        [input.parentElement!, 4],
      ] as const) {
        const box = intersect(element.getBoundingClientRect(), clipBounds(element), padding);
        if (box.right <= box.left || box.bottom <= box.top) continue;
        mask.appendChild(
          svgRect({
            x: String(box.left - viewport.left),
            y: String(box.top - viewport.top),
            width: String(box.right - box.left),
            height: String(box.bottom - box.top),
            rx: element === target ? "9" : "22",
            fill: "black",
          })
        );
      }
      svg.appendChild(mask);
      svg.appendChild(
        svgRect({
          width: "100%",
          height: "100%",
          class: "settings-search-dimmer",
          mask: `url(#${maskId})`,
        })
      );
      overlay.appendChild(svg);
      if (!registry || !Highlight) {
        // Same measured-range fallback as Settings for older Android WebViews.
        for (const range of ranges) {
          const clip = clipBounds(range.startContainer.parentElement);
          for (const rect of range.getClientRects()) {
            const box = intersect(rect, clip);
            if (box.right <= box.left || box.bottom <= box.top) continue;
            const mark = document.createElement("span");
            if (range === active) mark.className = "settings-search-active";
            Object.assign(mark.style, {
              left: `${box.left - viewport.left}px`,
              top: `${box.top - viewport.top}px`,
              width: `${box.right - box.left}px`,
              height: `${box.bottom - box.top}px`,
            });
            overlay.appendChild(mark);
          }
        }
      }
      document.body.appendChild(overlay);
    };
    const schedule = () => {
      if (!frame && !disposed) frame = view.requestAnimationFrame(paint);
    };
    const viewportChanged = () => {
      lastScrollKey = "";
      schedule();
    };
    const visualViewport = __WITH_ANDROID__ ? view.visualViewport : null;
    const syncFocus = () => {
      if (!focusedSearch()) {
        if (frame) view.cancelAnimationFrame(frame);
        frame = 0;
        lastScrollKey = "";
        clear();
      } else schedule();
    };
    const keyDown = (event: KeyboardEvent) => {
      const input = focusedSearch();
      if (!input || event.isComposing || event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        input.blur();
        syncFocus();
      } else if (event.key === "Enter" && matchCount) {
        event.preventDefault();
        event.stopPropagation();
        activeIndex = (activeIndex + (event.shiftKey ? -1 : 1) + matchCount) % matchCount;
        selectionRevision += 1;
        schedule();
      }
    };
    const blurWindow = () => {
      windowFocused = false;
      clear();
    };
    const focusWindow = () => {
      windowFocused = true;
      syncFocus();
    };
    const observer = new MutationObserver(schedule);
    observer.observe(root, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["hidden", "aria-hidden", "style", "class", "data-state"],
    });
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resizeObserver?.observe(root);
    document.addEventListener("focusin", syncFocus);
    document.addEventListener("focusout", syncFocus);
    document.addEventListener("keydown", keyDown, true);
    document.addEventListener("scroll", schedule, true);
    view.addEventListener("blur", blurWindow);
    view.addEventListener("focus", focusWindow);
    view.addEventListener("resize", schedule);
    visualViewport?.addEventListener("resize", viewportChanged);
    visualViewport?.addEventListener("scroll", viewportChanged);
    schedule();
    return () => {
      disposed = true;
      observer.disconnect();
      resizeObserver?.disconnect();
      document.removeEventListener("focusin", syncFocus);
      document.removeEventListener("focusout", syncFocus);
      document.removeEventListener("keydown", keyDown, true);
      document.removeEventListener("scroll", schedule, true);
      view.removeEventListener("blur", blurWindow);
      view.removeEventListener("focus", focusWindow);
      view.removeEventListener("resize", schedule);
      visualViewport?.removeEventListener("resize", viewportChanged);
      visualViewport?.removeEventListener("scroll", viewportChanged);
      if (frame) view.cancelAnimationFrame(frame);
      clear();
    };
  }, [pageRef, section, query, language, t]);
}

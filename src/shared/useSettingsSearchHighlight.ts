import { useEffect, type RefObject } from "react";
import { useSetUISettings } from "@/context/UISettingsProvider";
import { resolveSettingsSection, type SettingsSection } from "./SettingsSections";
import {
  findSettingsSearchMatches,
  settingsSearchStore,
  settingsSearchTerms,
} from "./SettingsSearch";
import { settingsSearchClipBounds, type SettingsSearchClip } from "./SettingsSearchClipping";
import { clipToSearchViewport, searchViewportBounds } from "./SearchViewport";
import "./settings-search.css";

const HIGHLIGHT_NAME = "baas-settings-search";
const ACTIVE_HIGHLIGHT_NAME = "baas-settings-search-active";
const SVG_NS = "http://www.w3.org/2000/svg";
let highlightOwner: object | null = null;
let maskSequence = 0;

type HighlightWindow = Window & {
  CSS?: {
    highlights?: { set(name: string, highlight: unknown): void; delete(name: string): void };
  };
  Highlight?: new (...ranges: Range[]) => unknown;
};

/** Actual text ranges remain owned by React; navigation and emphasis never replace them. */
export function useSettingsSearchHighlight(
  pageRef: RefObject<HTMLElement | null>,
  section: string,
  language?: string
) {
  const setUiSettings = useSetUISettings();
  useEffect(() => {
    const root = pageRef.current;
    if (!root) return;
    const document = root.ownerDocument;
    const view = document.defaultView as HighlightWindow | null;
    if (!view) return;
    const registry = view.CSS?.highlights;
    const Highlight = view.Highlight;
    const owner = {};
    const maskId = `settings-search-mask-${++maskSequence}`;
    let overlay: HTMLDivElement | null = null;
    let pendingFrame = 0;
    let lastScrollKey = "";
    let disposed = false;

    const clear = () => {
      if (highlightOwner === owner) {
        registry?.delete(HIGHLIGHT_NAME);
        registry?.delete(ACTIVE_HIGHLIGHT_NAME);
        highlightOwner = null;
      }
      overlay?.remove();
      overlay = null;
    };
    const rootIsActive = () =>
      root.getClientRects().length && !root.closest("[aria-hidden='true']");
    const searchIsFocused = () => {
      const { query, focusedSource } = settingsSearchStore.getSnapshot();
      const input = document.activeElement as HTMLElement | null;
      return Boolean(
        focusedSource &&
        settingsSearchTerms(query).length &&
        input?.dataset.settingsSearchSource === focusedSource &&
        input.getClientRects().length &&
        rootIsActive()
      );
    };
    const collectMatches = (query: string) => {
      const matches: { range: Range; section: SettingsSection }[] = [];
      const styles = new Map<Element, CSSStyleDeclaration>();
      const style = (element: Element) => {
        if (!styles.has(element)) styles.set(element, view.getComputedStyle(element));
        return styles.get(element)!;
      };
      for (const content of root.querySelectorAll<HTMLElement>("section[data-settings-section]")) {
        const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
          const parent = node.parentElement;
          if (
            !parent ||
            parent.closest(
              "[hidden], [aria-hidden='true'], script, style, input, textarea, select, option, .sr-only, [data-settings-search-ignore]"
            )
          )
            continue;
          // Inactive desktop categories still participate; collapsed results and
          // hidden controls inside those categories do not.
          let hidden = false;
          for (
            let element: Element | null = parent;
            element && element !== content;
            element = element.parentElement
          ) {
            const computed = style(element);
            if (computed.display === "none" || computed.visibility === "hidden") {
              hidden = true;
              break;
            }
          }
          if (hidden) continue;
          for (const match of findSettingsSearchMatches(node.textContent ?? "", query)) {
            const range = document.createRange();
            range.setStart(node, match.start);
            range.setEnd(node, match.end);
            matches.push({
              range,
              section: resolveSettingsSection(content.dataset.settingsSection).id,
            });
          }
        }
      }
      return matches;
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
                  ? (input.closest(".settings-mobile-navigation") ?? input)
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
      pendingFrame = 0;
      if (disposed || !rootIsActive()) {
        clear();
        lastScrollKey = "";
        return;
      }
      const { query } = settingsSearchStore.getSnapshot();
      const matches = collectMatches(query);
      settingsSearchStore.setMatches(query, matches.length, [
        ...new Set(matches.map((match) => match.section)),
      ]);
      const { focusedSource, activeIndex, selectionRevision } = settingsSearchStore.getSnapshot();
      const active = matches[activeIndex];
      clear();
      if (!searchIsFocused()) {
        lastScrollKey = "";
        return;
      }
      if (!active) return;
      const wide = view.matchMedia("(min-width: 1024px)").matches;
      if (wide && active.section !== section) {
        setUiSettings((settings) =>
          settings.settingsSection === active.section
            ? settings
            : { ...settings, settingsSection: active.section }
        );
        return;
      }
      const input = document.activeElement as HTMLElement;
      const scrollKey = `${focusedSource}\0${query}\0${activeIndex}\0${selectionRevision}\0${wide}`;
      if (scrollKey !== lastScrollKey) {
        lastScrollKey = scrollKey;
        reveal(active.range, input);
      }
      const ranges = matches
        .map((match) => match.range)
        .filter((range) => range.getClientRects().length);
      if (registry && Highlight) {
        registry.set(HIGHLIGHT_NAME, new Highlight(...ranges));
        registry.set(ACTIVE_HIGHLIGHT_NAME, new Highlight(active.range));
        highlightOwner = owner;
      }
      overlay = document.createElement("div");
      overlay.className = "settings-search-overlays";
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
      overlay.dataset.matchCount = String(matches.length);
      overlay.dataset.activeSection = active.section;
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
        active.range.startContainer.parentElement?.closest<HTMLElement>(
          ".settings-row, .settings-block, .settings-version-fields > div, .settings-version-footer, .sha-diagnostics-toolbar, tr, .settings-group-title, .settings-page-title"
        ) ?? active.range.startContainer.parentElement!;
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
      // Older WebViews paint measured ranges without changing fonts, selection,
      // event handling or the user's custom cursor.
      if (!registry || !Highlight) {
        for (const range of ranges) {
          const clip = clipBounds(range.startContainer.parentElement);
          for (const rect of range.getClientRects()) {
            const box = intersect(rect, clip);
            if (box.right <= box.left || box.bottom <= box.top) continue;
            const mark = document.createElement("span");
            if (range === active.range) mark.className = "settings-search-active";
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
      if (!pendingFrame && !disposed) pendingFrame = view.requestAnimationFrame(paint);
    };
    const viewportChanged = () => {
      lastScrollKey = "";
      schedule();
    };
    const visualViewport = __WITH_ANDROID__ ? view.visualViewport : null;
    const sync = () => {
      if (!searchIsFocused()) {
        if (pendingFrame) view.cancelAnimationFrame(pendingFrame);
        pendingFrame = 0;
        lastScrollKey = "";
        clear();
      }
      if (rootIsActive()) schedule();
    };
    const unsubscribe = settingsSearchStore.subscribe(sync);
    const observer = new MutationObserver(schedule);
    observer.observe(root, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["hidden", "aria-hidden", "style", "class"],
    });
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resizeObserver?.observe(root);
    document.addEventListener("scroll", schedule, true);
    view.addEventListener("resize", schedule);
    visualViewport?.addEventListener("resize", viewportChanged);
    visualViewport?.addEventListener("scroll", viewportChanged);
    sync();
    return () => {
      disposed = true;
      unsubscribe();
      observer.disconnect();
      resizeObserver?.disconnect();
      document.removeEventListener("scroll", schedule, true);
      view.removeEventListener("resize", schedule);
      visualViewport?.removeEventListener("resize", viewportChanged);
      visualViewport?.removeEventListener("scroll", viewportChanged);
      if (pendingFrame) view.cancelAnimationFrame(pendingFrame);
      clear();
    };
  }, [pageRef, section, language, setUiSettings]);
}

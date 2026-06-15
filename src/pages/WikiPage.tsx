import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";
import {
  getLocalizedField,
  getWikiArticles,
  LanguageCode,
  loadDocs,
  mapLanguage,
  WikiArticle,
} from "@/components/LocalWikiContent.tsx";
import { AlertCircle, BookOpen, ExternalLink, Loader2, Search, Tag, X } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { wikiCategoryKey } from "@/shared/I18nKeys";
import { Button } from "@/components/ui/Button";
import {
  getWebWikiWindow,
  openWebWikiWindow,
  WEB_WIKI_URL,
  webWikiEvents,
} from "@/components/WebWikiViewer";

// ========= Utils Functions ==========
interface PreparedArticle extends WikiArticle {
  localizedTitle: string;
  localizedSummary: string;
  bodyHtml: string;
  searchIndex: string;
}

const stripHtml = (html: string) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const buildSearchIndex = (title: string, summary: string, bodyText: string, tags: string[]) =>
  `${title} ${summary} ${bodyText} ${tags.join(" ")}`.toLowerCase();

const overlayCls =
  "fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50";

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const webWikiLoadTimeoutMs = 20000;
const floatingButtonSize = 48;
const floatingButtonMargin = 24;
const trafficLightBase =
  "h-3 w-3 rounded-full border border-black/10 shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70";

const initialFloatingButtonPosition = () => ({
  x: Math.max(floatingButtonMargin, window.innerWidth - floatingButtonSize - floatingButtonMargin),
  y: Math.max(floatingButtonMargin, window.innerHeight - floatingButtonSize - floatingButtonMargin),
});

const WebWikiModal: React.FC<{
  mode: "modal" | "pinned";
  loadState: "loading" | "loaded" | "failed";
  onLoad: () => void;
  onFailed: () => void;
  onClose: () => void;
  onDetach: () => void;
  onPin: () => void;
}> = ({ mode, loadState, onLoad, onFailed, onClose, onDetach, onPin }) => {
  const { t } = useTranslation();
  const isModal = mode === "modal";

  return (
    <div
      className={
        isModal
          ? "fixed inset-0 z-120 flex flex-col overflow-hidden bg-slate-950 text-white"
          : "hidden"
      }
      aria-hidden={!isModal}
    >
      <header className="relative flex h-11 shrink-0 items-center justify-between border-b border-white/10 bg-slate-900/95 px-4">
        <div className="flex items-center gap-2">
          <button
            type="button"
            title={t("wiki.web.close")}
            aria-label={t("wiki.web.close")}
            onClick={onClose}
            className={`${trafficLightBase} bg-[#ff5f57] hover:bg-[#ff6f68]`}
          />
          <button
            type="button"
            title={t("wiki.web.detach")}
            aria-label={t("wiki.web.detach")}
            onClick={onDetach}
            className={`${trafficLightBase} bg-[#febc2e] hover:bg-[#ffd15c]`}
          />
          <button
            type="button"
            title={t("wiki.web.pin")}
            aria-label={t("wiki.web.pin")}
            onClick={onPin}
            className={`${trafficLightBase} bg-[#28c840] hover:bg-[#4cda64]`}
          />
        </div>
        <div className="pointer-events-none absolute left-1/2 -translate-x-1/2 text-sm font-medium text-slate-100">
          {t("wiki.web.title")}
        </div>
        <div className="h-3 w-16" />
      </header>

      <div className="relative min-h-0 flex-1 overflow-hidden bg-white">
        <iframe
          title={t("wiki.web.title")}
          src={WEB_WIKI_URL}
          onLoad={onLoad}
          onError={onFailed}
          className="h-full w-full border-0 bg-white"
          sandbox="allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-presentation allow-same-origin allow-scripts"
        />

        {loadState === "loading" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-950 text-slate-100">
            <Loader2 className="h-8 w-8 animate-spin text-primary-400" />
            <p className="text-sm">{t("wiki.web.loading")}</p>
          </div>
        )}

        {loadState === "failed" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-950 px-6 text-center text-slate-100">
            <AlertCircle className="h-9 w-9 text-red-400" />
            <h1 className="text-lg font-semibold">{t("wiki.web.failed")}</h1>
            <p className="max-w-md text-sm text-slate-400">{WEB_WIKI_URL}</p>
          </div>
        )}
      </div>
    </div>
  );
};

// ========= Article Modal ==========
const ArticleModal: React.FC<{
  open: boolean;
  article: PreparedArticle | null;
  onClose: () => void;
}> = ({ open, article, onClose }) => {
  const { i18n } = useTranslation();
  // ESCAPE Key to Close
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open || !article) return null;

  return (
    <div className={overlayCls} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 10 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-h-[95vh] m-5 overflow-hidden rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-2xl flex flex-col"
      >
        <CardHeader className="space-y-2 border-b border-slate-200 dark:border-slate-700 p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <BookOpen className="w-5 h-5 text-primary-600 dark:text-primary-400" />
              <CardTitle className="text-lg">{article.localizedTitle}</CardTitle>
            </div>
            <button
              onClick={onClose}
              className="rounded-full p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              <X className="w-5 h-5 text-slate-500" />
            </button>
          </div>
          <CardDescription>{article.localizedSummary}</CardDescription>
          <div className="flex flex-wrap gap-2">
            {article.tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-1 rounded-full bg-primary-100/70 dark:bg-primary-900/40 px-2 py-0.5 text-xs text-primary-700 dark:text-primary-300"
              >
                <Tag size={12} />
                {tag}
              </span>
            ))}
          </div>
        </CardHeader>

        <CardContent className="flex-1 overflow-y-auto scroll-embedded prose prose-sm dark:prose-invert max-w-none p-4 cursor-text allow-select-text">
          {/*<article dangerouslySetInnerHTML={{ __html: article.bodyHtml }} />*/}
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
            {article.body[i18n.language as LanguageCode]}
          </ReactMarkdown>
        </CardContent>
      </motion.div>
    </div>
  );
};

// ========= Wiki Page Main Component ==========
const WikiPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const language = mapLanguage(i18n.language);

  const [query, setQuery] = useState("");
  const [articlesEntry, setArticlesEntry] = useState<WikiArticle[] | null>(null);
  const deferredQuery = useDeferredValue(query);
  const [activeCategory, setActiveCategory] = useState<WikiArticle["category"] | "all">("all");
  const [selectedArticle, setSelectedArticle] = useState<PreparedArticle | null>(null);
  const [preparedArticles, setPreparedArticles] = useState<PreparedArticle[]>([]);
  const [webWikiMode, setWebWikiMode] = useState<
    "closed" | "modal" | "pinned" | "detached" | "detachedPinned"
  >("closed");
  const [webWikiLoadState, setWebWikiLoadState] = useState<"loading" | "loaded" | "failed">(
    "loading"
  );
  const [webWikiButtonPosition, setWebWikiButtonPosition] = useState(initialFloatingButtonPosition);
  const dragStartRef = useRef<{
    pointerX: number;
    pointerY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const draggedRef = useRef(false);

  useEffect(() => {
    if (!__WITH_TAURI__) return;

    let cleanup: Array<() => void> = [];
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      cleanup = [
        await listen(webWikiEvents.pinned, () => setWebWikiMode("detachedPinned")),
        await listen(webWikiEvents.closed, () => {
          setWebWikiMode("closed");
          setWebWikiLoadState("loading");
        }),
        await listen(webWikiEvents.returnMain, () => {
          setWebWikiLoadState("loading");
          setWebWikiMode("modal");
        }),
        await listen(webWikiEvents.shown, () => setWebWikiMode("detached")),
      ];
    })().catch(console.error);

    return () => {
      cleanup.forEach((unlisten) => unlisten());
    };
  }, []);

  const openWebWiki = useCallback(async () => {
    if (!__WITH_TAURI__) {
      window.open("https://baas.wiki", "_blank");
      return;
    }
    const detachedWindow = await getWebWikiWindow();
    if (detachedWindow) {
      setWebWikiMode("detached");
      await detachedWindow.show();
      await detachedWindow.setFocus();
      return;
    }
    if (webWikiMode === "closed" || webWikiMode === "detached") {
      setWebWikiLoadState("loading");
    }
    setWebWikiMode("modal");
  }, [webWikiMode]);

  useEffect(() => {
    if (webWikiMode !== "modal" || webWikiLoadState !== "loading") return;
    const timer = window.setTimeout(() => setWebWikiLoadState("failed"), webWikiLoadTimeoutMs);
    return () => window.clearTimeout(timer);
  }, [webWikiLoadState, webWikiMode]);

  const closeWebWiki = useCallback(async () => {
    setWebWikiMode("closed");
    setWebWikiLoadState("loading");
    const detachedWindow = await getWebWikiWindow();
    await detachedWindow?.destroy().catch(console.error);
  }, []);

  const detachWebWiki = useCallback(async () => {
    if (!__WITH_TAURI__) return;
    setWebWikiMode("detached");
    setWebWikiLoadState("loading");
    await openWebWikiWindow("detached");
  }, []);

  const pinWebWiki = useCallback(() => {
    setWebWikiMode("pinned");
  }, []);

  const beginFloatingDrag = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      draggedRef.current = false;
      dragStartRef.current = {
        pointerX: event.clientX,
        pointerY: event.clientY,
        originX: webWikiButtonPosition.x,
        originY: webWikiButtonPosition.y,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [webWikiButtonPosition]
  );

  const updateFloatingDrag = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const start = dragStartRef.current;
    if (!start) return;

    const dx = event.clientX - start.pointerX;
    const dy = event.clientY - start.pointerY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) draggedRef.current = true;

    setWebWikiButtonPosition({
      x: clamp(
        start.originX + dx,
        floatingButtonMargin / 2,
        window.innerWidth - floatingButtonSize - floatingButtonMargin / 2
      ),
      y: clamp(
        start.originY + dy,
        floatingButtonMargin / 2,
        window.innerHeight - floatingButtonSize - floatingButtonMargin / 2
      ),
    });
  }, []);

  const endFloatingDrag = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    dragStartRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  const clickFloatingButton = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (draggedRef.current) {
        event.preventDefault();
        draggedRef.current = false;
        return;
      }
      openWebWiki().catch(console.error);
    },
    [openWebWiki]
  );

  // ------------------------------
  // Fetch Wiki Articles once
  // ------------------------------
  useEffect(() => {
    let isMounted = true;
    (async () => {
      try {
        const data = await getWikiArticles(language);
        if (isMounted) setArticlesEntry(data);
      } catch (err) {
        console.error("Failed to load wiki articles:", err);
      }
    })();
    return () => {
      isMounted = false;
    };
  }, []);

  // ------------------------------
  // Prepare Articles (after loaded)
  // ------------------------------

  useEffect(() => {
    if (!articlesEntry) return;

    const prepareArticles = async () => {
      const results = await Promise.all(
        articlesEntry.map(async (article) => {
          const localizedTitle = getLocalizedField(article.title, language);
          const localizedSummary = getLocalizedField(article.summary, language);

          let bodyHtml = article.body[language] ?? article.body.en ?? "";
          let articleAppended = article;

          // Async Fetching Language Pack
          if (!article.body[language]) {
            try {
              const loadedBody = await loadDocs(article.basename, language);
              articleAppended = { ...article, body: { ...article.body, ...loadedBody } };
              if (loadedBody) {
                bodyHtml = loadedBody[language]!;
              }
            } catch (err) {
              console.error(`Failed to load ${article.basename} (${language})`, err);
            }
          }

          const bodyText = stripHtml(bodyHtml);
          const searchIndex = buildSearchIndex(
            localizedTitle,
            localizedSummary,
            bodyText,
            article.tags
          );

          return { ...articleAppended, localizedTitle, localizedSummary, bodyHtml, searchIndex };
        })
      );
      setPreparedArticles(results);
      return results;
    };
    prepareArticles().then(undefined);
  }, [articlesEntry, language]);

  // ------------------------------
  // Classification Statistics
  // ------------------------------
  const categoriesWithCounts = useMemo(() => {
    if (!preparedArticles.length) return [];
    const counts = new Map<WikiArticle["category"], number>();
    preparedArticles.forEach((article) => {
      counts.set(article.category, (counts.get(article.category) ?? 0) + 1);
    });
    return Array.from(counts.entries());
  }, [preparedArticles]);

  // ------------------------------
  // Article Filter
  // ------------------------------
  const filteredArticles = useMemo(() => {
    if (!preparedArticles.length) return [];
    const normalizedQuery = deferredQuery.trim().toLowerCase();
    return preparedArticles.filter((article) => {
      const matchCategory = activeCategory === "all" || article.category === activeCategory;
      const matchQuery = !normalizedQuery || article.searchIndex.includes(normalizedQuery);
      return matchCategory && matchQuery;
    });
  }, [preparedArticles, deferredQuery, activeCategory]);

  // ------------------------------
  // Render
  // ------------------------------
  if (!articlesEntry) {
    return (
      <div className="flex h-full items-center justify-center text-slate-500 dark:text-slate-400">
        <Loader2 className="animate-spin mr-2 h-10 w-10" />
      </div>
    );
  }

  // Category Button Component
  const renderCategoryChip = (
    category: WikiArticle["category"] | "all",
    label: string,
    count?: number
  ) => {
    const isActive = activeCategory === category;
    return (
      <button
        key={category}
        onClick={() => setActiveCategory(category)}
        className={`px-3 py-1 rounded-full text-sm transition-colors ${
          isActive
            ? "bg-primary-600 text-white shadow-md"
            : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-primary-100/70 dark:hover:bg-slate-700"
        }`}
      >
        {label}
        {typeof count === "number" && <span className="ml-1 opacity-80">({count})</span>}
      </button>
    );
  };

  const renderTag = (tag: string) => (
    <span
      key={tag}
      className="inline-flex items-center gap-1 rounded-full bg-primary-100/70 dark:bg-primary-900/40 px-2 py-0.5 text-xs text-primary-700 dark:text-primary-300"
    >
      <Tag size={12} />
      {tag}
    </span>
  );

  // ========= Page Render ==========
  return (
    <div className="flex h-full flex-col gap-4 overflow-hidden">
      {/* Header */}
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <BookOpen className="w-6 h-6 text-primary-600 dark:text-primary-400" />
            {t("wiki.title")}
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 max-w-3xl">
            {t("wiki.subtitle")}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={() => openWebWiki().catch(console.error)}
          title={t("wiki.web.title")}
          className="shrink-0"
        >
          <ExternalLink className="h-4 w-4" />
          {t("wiki.web.title")}
        </Button>
      </header>

      {/* Search Box */}
      <div className="relative p-1">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
          size={16}
        />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("wiki.searchPlaceholder")}
          className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 pl-10 pr-3 py-2 text-sm text-slate-800 dark:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 transition cursor-text"
          aria-label={t("wiki.searchPlaceholder")}
        />
      </div>

      {/* Classification */}
      <div className="flex flex-wrap gap-2">
        {renderCategoryChip("all", t("wiki.category.all"), preparedArticles.length)}
        {categoriesWithCounts.map(([cat, count]) =>
          renderCategoryChip(cat, t(wikiCategoryKey(cat)), count)
        )}
      </div>

      {/* Search Results Statistics */}
      <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
        <span>{t("wiki.resultsCount", { count: filteredArticles.length })}</span>
        {query && (
          <button className="underline" onClick={() => setQuery("")}>
            {t("wiki.clearSearch")}
          </button>
        )}
      </div>

      {/* Passgage List */}
      <div className="flex-1 overflow-y-auto space-y-3 scroll-embedded p-2 pr-4">
        <AnimatePresence initial={false}>
          {filteredArticles.map((article) => (
            <motion.div
              key={article.id}
              layout
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.15, ease: "easeOut" }}
            >
              <Card
                onClick={() => setSelectedArticle(article)}
                className="cursor-pointer transition-colors hover:border-primary-300 dark:hover:border-primary-500"
              >
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center justify-between gap-3">
                    <span>{article.localizedTitle}</span>
                  </CardTitle>
                  <CardDescription>{article.localizedSummary}</CardDescription>
                </CardHeader>
                <CardContent className="p-2! flex gap-2 flex-wrap">
                  {article.tags.slice(0, 4).map(renderTag)}
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </AnimatePresence>

        {filteredArticles.length === 0 && (
          <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 p-6 text-center text-sm text-slate-500 dark:text-slate-400">
            {t("wiki.noResults")}
          </div>
        )}
      </div>

      {/* Modal */}
      <AnimatePresence>
        {selectedArticle && (
          <ArticleModal
            open={!!selectedArticle}
            article={selectedArticle}
            onClose={() => setSelectedArticle(null)}
          />
        )}
      </AnimatePresence>

      {(webWikiMode === "modal" || webWikiMode === "pinned") &&
        createPortal(
          <WebWikiModal
            mode={webWikiMode}
            loadState={webWikiLoadState}
            onLoad={() => setWebWikiLoadState("loaded")}
            onFailed={() => setWebWikiLoadState("failed")}
            onClose={() => closeWebWiki().catch(console.error)}
            onDetach={() => detachWebWiki().catch(console.error)}
            onPin={pinWebWiki}
          />,
          document.body
        )}

      {(webWikiMode === "pinned" || webWikiMode === "detachedPinned") &&
        createPortal(
          <button
            type="button"
            title={t("wiki.web.title")}
            aria-label={t("wiki.web.title")}
            onPointerDown={beginFloatingDrag}
            onPointerMove={updateFloatingDrag}
            onPointerUp={endFloatingDrag}
            onPointerCancel={endFloatingDrag}
            onClick={clickFloatingButton}
            className="fixed z-60 flex h-12 w-12 items-center justify-center rounded-full border border-primary-300/70 bg-primary-600 text-white shadow-lg shadow-primary-950/20 transition hover:bg-primary-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 dark:border-primary-400/50 dark:bg-primary-500 dark:hover:bg-primary-400"
            style={{ left: webWikiButtonPosition.x, top: webWikiButtonPosition.y }}
          >
            <BookOpen className="h-5 w-5" />
          </button>,
          document.body
        )}
    </div>
  );
};

export default WikiPage;

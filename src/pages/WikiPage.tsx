import React, {useDeferredValue, useEffect, useMemo, useState} from "react";
import {useTranslation} from "react-i18next";
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from "@/components/ui/Card";
import {wikiArticles, mapLanguage, getLocalizedField, WikiArticle, LanguageCode} from "@/lib/wikiContent.ts";
import {Search, BookOpen, Tag, X} from "lucide-react";
import {motion, AnimatePresence} from "framer-motion";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

// ========= Utils Functions ==========
interface PreparedArticle extends WikiArticle {
  localizedTitle: string;
  localizedSummary: string;
  bodyHtml: string;
  searchIndex: string;
}

const stripHtml = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const buildSearchIndex = (title: string, summary: string, bodyText: string, tags: string[]) =>
  `${title} ${summary} ${bodyText} ${tags.join(" ")}`.toLowerCase();

const overlayCls =
  "fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50";

// ========= Article Modal ==========
const ArticleModal: React.FC<{
  open: boolean;
  article: PreparedArticle | null;
  onClose: () => void;
}> = ({open, article, onClose}) => {
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
  const { i18n } = useTranslation();

  // @ts-ignore
  return (
    <div
      className={overlayCls}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        initial={{opacity: 0, scale: 0.95, y: 10}}
        animate={{opacity: 1, scale: 1, y: 0}}
        exit={{opacity: 0, scale: 0.97, y: 10}}
        transition={{duration: 0.2, ease: "easeOut"}}
        onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-h-[95vh] m-5 overflow-hidden rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-2xl flex flex-col"
      >
        <CardHeader className="space-y-2 border-b border-slate-200 dark:border-slate-700 p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <BookOpen className="w-5 h-5 text-primary-600 dark:text-primary-400"/>
              <CardTitle className="text-lg">{article.localizedTitle}</CardTitle>
            </div>
            <button
              onClick={onClose}
              className="rounded-full p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              <X className="w-5 h-5 text-slate-500"/>
            </button>
          </div>
          <CardDescription>{article.localizedSummary}</CardDescription>
          <div className="flex flex-wrap gap-2">
            {article.tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-1 rounded-full bg-primary-100/70 dark:bg-primary-900/40 px-2 py-0.5 text-xs text-primary-700 dark:text-primary-300"
              >
                <Tag size={12}/>
                {tag}
              </span>
            ))}
          </div>
        </CardHeader>

        <CardContent
          className="flex-1 overflow-y-auto scroll-embedded prose prose-sm dark:prose-invert max-w-none p-4 cursor-text allow-select-text">
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
  const {t, i18n} = useTranslation();
  const language = mapLanguage(i18n.language);

  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [activeCategory, setActiveCategory] = useState<WikiArticle["category"] | "all">("all");
  const [selectedArticle, setSelectedArticle] = useState<PreparedArticle | null>(null);

  // Prepare the article
  const preparedArticles: PreparedArticle[] = useMemo(() => {
    return wikiArticles.map((article) => {
      const localizedTitle = getLocalizedField(article.title, language);
      const localizedSummary = getLocalizedField(article.summary, language);
      const bodyHtml = article.body[language] ?? article.body.en ?? "";
      const bodyText = stripHtml(bodyHtml);
      const searchIndex = buildSearchIndex(localizedTitle, localizedSummary, bodyText, article.tags);
      return {...article, localizedTitle, localizedSummary, bodyHtml, searchIndex};
    });
  }, [language]);

  // Classification Statistics
  const categoriesWithCounts = useMemo(() => {
    const counts = new Map<WikiArticle["category"], number>();
    preparedArticles.forEach((article) => {
      counts.set(article.category, (counts.get(article.category) ?? 0) + 1);
    });
    return Array.from(counts.entries());
  }, [preparedArticles]);

  // Article Filter
  const filteredArticles = useMemo(() => {
    const normalizedQuery = deferredQuery.trim().toLowerCase();
    return preparedArticles.filter((article) => {
      const matchCategory = activeCategory === "all" || article.category === activeCategory;
      const matchQuery = !normalizedQuery || article.searchIndex.includes(normalizedQuery);
      return matchCategory && matchQuery;
    });
  }, [preparedArticles, deferredQuery, activeCategory]);

  // Classification Button
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
      <Tag size={12}/>
      {tag}
    </span>
  );

  // ========= Page Render ==========
  return (
    <div className="flex h-full flex-col gap-4 overflow-hidden">
      {/* Header */}
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
          <BookOpen className="w-6 h-6 text-primary-600 dark:text-primary-400"/>
          {t("wiki.title")}
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-400 max-w-3xl">
          {t("wiki.subtitle")}
        </p>
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
          placeholder={t("wiki.searchPlaceholder") ?? ""}
          className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 pl-10 pr-3 py-2 text-sm text-slate-800 dark:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 transition cursor-text"
          aria-label={t("wiki.searchPlaceholder") ?? "Search"}
        />
      </div>

      {/* Classification */}
      <div className="flex flex-wrap gap-2">
        {renderCategoryChip("all", t("wiki.category.all") ?? "All", preparedArticles.length)}
        {categoriesWithCounts.map(([cat, count]) =>
          renderCategoryChip(cat, t(`wiki.category.${cat}` as const) ?? cat, count)
        )}
      </div>

      {/* Search Results Statistics */}
      <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
        <span>{t("wiki.resultsCount", {count: filteredArticles.length})}</span>
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
              initial={{opacity: 0, y: 6}}
              animate={{opacity: 1, y: 0}}
              exit={{opacity: 0, y: -6}}
              transition={{duration: 0.15, ease: "easeOut"}}
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
                <CardContent className="!p-2 flex gap-2 flex-wrap">
                  {article.tags.slice(0, 4).map(renderTag)}
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </AnimatePresence>

        {filteredArticles.length === 0 && (
          <div
            className="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 p-6 text-center text-sm text-slate-500 dark:text-slate-400">
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
    </div>
  );
};

export default WikiPage;

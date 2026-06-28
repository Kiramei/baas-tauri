import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, ArrowLeft, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/Button";
import { resolveHttpBase } from "@/store/WebsocketStore";

const remoteOrigin = "https://baas.kiramei.cn";

const cleanArticleHtml = (html: string) => {
  const document = new DOMParser().parseFromString(html, "text/html");
  document.querySelectorAll("script, style, link, noscript").forEach((node) => node.remove());
  const article = document.querySelector("article") ?? document.querySelector("main") ?? document.body;
  article.querySelectorAll("svg").forEach((node) => node.remove());
  article.querySelectorAll("a[href]").forEach((node) => {
    const link = node as HTMLAnchorElement;
    const href = link.getAttribute("href") ?? "";
    if (href.startsWith("/")) {
      link.setAttribute("href", `${remoteOrigin}${href}`);
    }
  });
  article.querySelectorAll("img[src]").forEach((node) => {
    const image = node as HTMLImageElement;
    const src = image.getAttribute("src") ?? "";
    if (src.startsWith("/")) {
      image.setAttribute("src", `${remoteOrigin}${src}`);
    }
  });
  return article.innerHTML;
};

const wikiPathFromUrl = (value: string) => {
  try {
    const url = new URL(value, remoteOrigin);
    if (url.origin !== remoteOrigin || !url.pathname.startsWith("/docs/")) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
};

const AndroidRemoteWiki: React.FC = () => {
  const { i18n } = useTranslation();
  const initialPath = useMemo(
    () => (i18n.language.startsWith("zh") ? "/docs/zh/" : "/docs/en/"),
    [i18n.language]
  );
  const [path, setPath] = useState(initialPath);
  const [html, setHtml] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPath(initialPath);
  }, [initialPath]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`${resolveHttpBase()}/android/wiki?path=${encodeURIComponent(path)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(await response.text());
        return response.json() as Promise<{ html: string }>;
      })
      .then((payload) => {
        if (!cancelled) setHtml(cleanArticleHtml(payload.html));
      })
      .catch((fetchError) => {
        if (!cancelled) setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const handleClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement).closest("a[href]") as HTMLAnchorElement | null;
    if (!anchor) return;
    const nextPath = wikiPathFromUrl(anchor.href);
    if (!nextPath) return;
    event.preventDefault();
    setPath(nextPath);
  }, []);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-white text-slate-600 dark:bg-slate-950 dark:text-slate-300">
        <Loader2 className="h-7 w-7 animate-spin text-primary-500" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-white p-6 text-center text-slate-700 dark:bg-slate-950 dark:text-slate-200">
        <AlertCircle className="h-8 w-8 text-red-500" />
        <p className="max-w-md text-sm">{error}</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-white p-5 dark:bg-slate-950" onClick={handleClick}>
      <Button type="button" variant="ghost" size="sm" className="mb-4" onClick={() => setPath(initialPath)}>
        <ArrowLeft className="h-4 w-4" />
        Docs
      </Button>
      <div
        className="wiki-remote-content mx-auto max-w-3xl text-slate-800 dark:text-slate-100 [&_a]:text-primary-600 [&_a]:underline dark:[&_a]:text-primary-300 [&_blockquote]:border-l-4 [&_blockquote]:border-primary-200 [&_blockquote]:pl-4 [&_code]:rounded [&_code]:bg-slate-100 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-sm dark:[&_code]:bg-slate-800 [&_h1]:mb-4 [&_h1]:text-3xl [&_h1]:font-bold [&_h2]:mb-3 [&_h2]:mt-6 [&_h2]:border-b [&_h2]:border-slate-200 [&_h2]:pb-2 [&_h2]:text-2xl [&_h2]:font-semibold dark:[&_h2]:border-slate-800 [&_h3]:mb-2 [&_h3]:mt-5 [&_h3]:text-xl [&_h3]:font-semibold [&_img]:my-4 [&_img]:max-w-full [&_li]:my-1 [&_ol]:mb-4 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:mb-4 [&_p]:leading-7 [&_pre]:mb-4 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-slate-950 [&_pre]:p-4 [&_pre]:text-sm [&_pre]:text-slate-100 [&_table]:mb-4 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-slate-200 [&_td]:p-2 dark:[&_td]:border-slate-800 [&_th]:border [&_th]:border-slate-200 [&_th]:p-2 dark:[&_th]:border-slate-800 [&_ul]:mb-4 [&_ul]:list-disc [&_ul]:pl-6"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
};

export default AndroidRemoteWiki;

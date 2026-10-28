import type { ComponentProps } from "react";
import Markdown from "react-markdown";
import { toast } from "sonner";
import { useAppTranslation } from "@/shared/useAppTranslation";

const repositoryFiles = "https://github.com/Kiramei/baas-tauri/blob/main/";

/** Release-note links may open files and web pages, never executable URLs. */
export function releaseNoteUrl(value: string): string | undefined {
  if (value.startsWith("#")) return value;
  try {
    const url = new URL(value, repositoryFiles);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function ReleaseNoteLink({ children, href }: ComponentProps<"a">) {
  const { t } = useAppTranslation();
  if (!href) return <span>{children}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => {
        if (!__WITH_TAURI__ || href.startsWith("#")) return;
        event.preventDefault();
        void import("@tauri-apps/plugin-opener")
          .then(({ openUrl }) => openUrl(href))
          .catch(() => toast.error(t("about.openLinkFailed")));
      }}
    >
      {children}
    </a>
  );
}

const markdownComponents = { a: ReleaseNoteLink };

/** Render release Markdown without raw HTML or remote image requests. */
export default function ReleaseNotesContent({ markdown }: { markdown: string }) {
  return (
    <article className="prose prose-sm dark:prose-invert max-w-none text-foreground [overflow-wrap:anywhere] prose-headings:text-foreground prose-strong:text-foreground prose-a:text-primary prose-blockquote:text-muted-foreground prose-code:text-foreground prose-pre:bg-secondary [&_pre]:whitespace-pre-wrap">
      <Markdown
        skipHtml
        disallowedElements={["img"]}
        urlTransform={releaseNoteUrl}
        components={markdownComponents}
      >
        {markdown}
      </Markdown>
    </article>
  );
}

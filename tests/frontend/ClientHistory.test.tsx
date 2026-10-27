import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import ReleaseNotesContent, { releaseNoteUrl } from "../../src/components/ReleaseNotesContent";

const i18n = createInstance();
await i18n.init({
  lng: "en",
  resources: { en: { translation: { about: { openLinkFailed: "Could not open the link" } } } },
});

function renderMarkdown(markdown: string) {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <ReleaseNotesContent markdown={markdown} />
    </I18nextProvider>
  );
}

describe("bundled client release history", () => {
  test("renders the actual release-publishing source as headings, lists and emphasis", () => {
    const markdown = readFileSync(new URL("../../UPDATE.md", import.meta.url), "utf8");
    const html = renderMarkdown(markdown);
    const version = markdown.match(/^## (.+)$/m)?.[1];
    expect(version).toBeDefined();
    expect(html).toContain(`<h2>${version}</h2>`);
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<ol>");
    expect(html).toContain("<strong>Editable scheduler workflow</strong>");
    expect(html).not.toContain("## ");
    expect(html).not.toContain("**Editable");
  });

  test("raw HTML and executable URLs never become active content", () => {
    const html = renderMarkdown(
      '<script>alert("unsafe")</script>\n\n<img src="https://image.example/test.png" onerror="alert(1)">\n\n[unsafe](javascript:alert%281%29)\n\n[also unsafe](data:text/html,unsafe)\n\n![remote](https://image.example/another.png)\n\nSafe **content** and `code <text>`'
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:text/html");
    expect(html).not.toContain("https://image.example");
    expect(html).toContain("<span>unsafe</span>");
    expect(html).toContain("<strong>content</strong>");
    expect(html).toContain("<code>code &lt;text&gt;</code>");
  });

  test("links preserve safe browser behavior and resolve repository-relative files", () => {
    const html = renderMarkdown(
      "[Project](https://github.com/Kiramei/baas-tauri) and [Readme](README.md)"
    );
    expect(html).toContain('href="https://github.com/Kiramei/baas-tauri"');
    expect(html).toContain('href="https://github.com/Kiramei/baas-tauri/blob/main/README.md"');
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
  });

  test.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "java\nscript:alert(1)",
    "data:text/html,<script>unsafe</script>",
    "file:///etc/passwd",
    "tauri://localhost",
  ])("refuses the non-web release link %s", (value) => {
    expect(releaseNoteUrl(value)).toBeUndefined();
  });

  test("internal anchors remain local and web addresses remain readable", () => {
    expect(releaseNoteUrl("#release-notes")).toBe("#release-notes");
    expect(releaseNoteUrl("https://example.test/path?q=test")).toBe(
      "https://example.test/path?q=test"
    );
  });
});

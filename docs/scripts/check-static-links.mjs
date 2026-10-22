import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const out = path.join(root, "docs/out");
const files = [];
function collect(directory) {
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) collect(file);
    else if (item.name === "index.html") files.push(file);
  }
}
collect(out);
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage();
const parsed = new Map();
const failures = [];
try {
  for (const file of files) {
    const route = `/${path.relative(out, path.dirname(file)).replaceAll("\\", "/")}/`.replaceAll(
      "//",
      "/"
    );
    const document = await page.evaluate(
      (html) => {
        const doc = new DOMParser().parseFromString(html, "text/html");
        return {
          ids: Array.from(doc.querySelectorAll("[id]")).map((element) => element.id),
          links: Array.from(doc.querySelectorAll("a[href]")).map((element) =>
            element.getAttribute("href")
          ),
          images: Array.from(doc.querySelectorAll("img[src],video[src],source[src]")).map(
            (element) => element.getAttribute("src")
          ),
        };
      },
      readFileSync(file, "utf8")
    );
    parsed.set(route, document);
  }
  for (const [route, document] of parsed) {
    for (const [kind, entries] of [
      ["link", document.links],
      ["media", document.images],
    ]) {
      for (const href of entries) {
        const target = new URL(href, `http://docs.invalid${route}`);
        if (target.origin !== "http://docs.invalid") continue;
        const pathname = decodeURIComponent(target.pathname);
        const normalized = pathname.endsWith("/") ? pathname : `${pathname}/`;
        const targetDoc = parsed.get(normalized);
        const asset = path.join(out, pathname);
        if (!targetDoc && !existsSync(asset))
          failures.push({ route, href, kind, reason: "missing target" });
        else if (
          kind === "link" &&
          targetDoc &&
          target.hash &&
          !targetDoc.ids.includes(decodeURIComponent(target.hash.slice(1)))
        )
          failures.push({ route, href, kind, reason: "missing anchor" });
      }
    }
  }
  const output = path.join(root, ".cache/docs-smoke");
  mkdirSync(output, { recursive: true });
  writeFileSync(
    path.join(output, "static-links.json"),
    `${JSON.stringify({ pages: parsed.size, failures }, null, 2)}\n`
  );
  console.log(JSON.stringify({ pages: parsed.size, failures }, null, 2));
  assert.equal(failures.length, 0, "Broken internal links/media in exported documentation");
} finally {
  await browser.close();
}

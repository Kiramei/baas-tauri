import { readFile, readdir, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { URL } from "node:url";

const outputRoot = resolve(process.argv[2] ?? "out");
const mount = `/${(process.env.NEXT_PUBLIC_BASE_PATH ?? "").split("/").filter(Boolean).join("/")}`;
const normalizedMount = mount === "/" ? "" : mount;
const origin = "https://baas-docs.invalid";

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? filesUnder(path) : [path];
    }),
  );
  return nested.flat();
}

function decodeHtmlAttribute(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&#x27;", "'");
}

function outputTarget(route) {
  if (!route) return join(outputRoot, "index.html");
  const segments = route.split("/");
  if (
    segments.some(
      (segment) =>
        segment === "." ||
        segment === ".." ||
        segment.includes("\\") ||
        [...segment].some((character) => {
          const codePoint = character.codePointAt(0);
          return codePoint <= 0x1f || codePoint === 0x7f;
        }),
    )
  ) {
    return null;
  }

  const path = resolve(outputRoot, ...segments);
  const relativePath = relative(outputRoot, path);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return null;
  }
  return extname(route) ? path : join(path, "index.html");
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

const htmlFiles = (await filesUnder(outputRoot)).filter((path) => path.endsWith(".html"));
const htmlCache = new Map();
const failures = new Set();

async function htmlAt(path) {
  if (!htmlCache.has(path)) htmlCache.set(path, await readFile(path, "utf8"));
  return htmlCache.get(path);
}

for (const source of htmlFiles) {
  const sourceName = relative(outputRoot, source).split(sep).join("/");
  const sourceDirectory = sourceName.slice(0, sourceName.lastIndexOf("/") + 1);
  const base = new URL(`${normalizedMount}/${sourceDirectory}`, origin);
  const html = await htmlAt(source);

  for (const match of html.matchAll(/(?:href|src)=["']([^"']+)["']/gu)) {
    const reference = decodeHtmlAttribute(match[1]);
    let url;
    try {
      url = new URL(reference, base);
    } catch {
      failures.add(`invalid URL: ${sourceName} -> ${reference}`);
      continue;
    }
    if (url.origin !== origin) continue;

    let absolutePath;
    try {
      absolutePath = decodeURIComponent(url.pathname);
    } catch {
      failures.add(`invalid URL encoding: ${sourceName} -> ${reference}`);
      continue;
    }
    if (
      normalizedMount &&
      absolutePath !== normalizedMount &&
      !absolutePath.startsWith(`${normalizedMount}/`)
    ) {
      failures.add(`escapes base path: ${sourceName} -> ${reference}`);
      continue;
    }

    const route = absolutePath.slice(normalizedMount.length).replace(/^\/+/, "");
    const target = outputTarget(route);
    if (target === null) {
      failures.add(`invalid local path: ${sourceName} -> ${reference}`);
      continue;
    }
    if (!(await isFile(target))) {
      failures.add(`missing target: ${sourceName} -> ${reference}`);
      continue;
    }

    if (url.hash.length > 1 && target.endsWith(".html")) {
      let fragment;
      try {
        fragment = decodeURIComponent(url.hash.slice(1));
      } catch {
        failures.add(`invalid anchor encoding: ${sourceName} -> ${reference}`);
        continue;
      }
      const targetHtml = await htmlAt(target);
      const ids = new Set(
        [...targetHtml.matchAll(/id=["']([^"']+)["']/gu)].map((id) =>
          decodeHtmlAttribute(id[1]),
        ),
      );
      if (!ids.has(fragment)) failures.add(`missing anchor: ${sourceName} -> ${reference}`);
    }
  }
}

if (failures.size > 0) {
  for (const failure of [...failures].sort()) console.error(failure);
  console.error(`Static documentation check failed with ${failures.size} unique error(s).`);
  process.exitCode = 1;
} else {
  console.log(`Static documentation check passed for ${htmlFiles.length} HTML pages.`);
}

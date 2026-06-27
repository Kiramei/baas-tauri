import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  existsSync,
} from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

const docsRoot = resolve(".");
const projectRoot = resolve("..");
const sourceFont = join(projectRoot, "scripts", "fonts-src", "Blueaka.ttf");
const fallbackFont = join(projectRoot, "public", "fonts", "Blueaka-Subset.woff2");
const outputFont = join(docsRoot, "public", "fonts", "Blueaka-Subset.woff2");
const tempText = join(docsRoot, ".next", "blueaka-subset-chars.txt");
const scanRoots = [join(docsRoot, "content"), join(docsRoot, "app"), join(docsRoot, "components")];
const textExtensions = new Set([".md", ".mdx", ".ts", ".tsx", ".js", ".jsx", ".json", ".css"]);

function logSkip(message) {
  console.warn(`[fonts] ${message}`);
}

function detectPython() {
  for (const command of ["python", "python3", "py"]) {
    const result = spawnSync(command, ["--version"], { stdio: "ignore" });
    if (result.status === 0) return command;
  }
  return null;
}

function collectText(root) {
  let result = "";
  if (!existsSync(root)) return result;

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      result += collectText(path);
      continue;
    }

    if (!textExtensions.has(extname(entry.name))) continue;
    try {
      result += readFileSync(path, "utf8");
    } catch {
      // Ignore unreadable source files; missing a few characters is better than failing docs build.
    }
  }

  return result;
}

function copyFallback() {
  if (!existsSync(fallbackFont)) {
    logSkip(
      "Blueaka subset tooling is unavailable and no fallback subset was found; continuing without regenerating the font."
    );
    return;
  }

  mkdirSync(dirname(outputFont), { recursive: true });
  copyFileSync(fallbackFont, outputFont);
  logSkip("Copied existing Blueaka subset from public/fonts.");
}

mkdirSync(dirname(outputFont), { recursive: true });

if (!existsSync(sourceFont)) {
  copyFallback();
  process.exit(0);
}

const python = detectPython();
if (!python) {
  copyFallback();
  process.exit(0);
}

const subsetCheck = spawnSync(python, ["-m", "fontTools.subset", "--help"], { stdio: "ignore" });
if (subsetCheck.status !== 0) {
  copyFallback();
  process.exit(0);
}

const text = scanRoots.map(collectText).join("\n");
const chars = Array.from(new Set((text || "BAAS Docs 文档").split("")))
  .sort()
  .join("");
mkdirSync(dirname(tempText), { recursive: true });
writeFileSync(tempText, chars, "utf8");

const result = spawnSync(
  python,
  [
    "-m",
    "fontTools.subset",
    sourceFont,
    `--output-file=${outputFont}`,
    `--text-file=${tempText}`,
    "--flavor=woff2",
    "--layout-features=*",
  ],
  { stdio: "inherit" }
);

if (result.status !== 0) {
  copyFallback();
  process.exit(0);
}

console.log(`[fonts] Generated ${outputFont}`);

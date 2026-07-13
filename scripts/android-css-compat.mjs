import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const distAssets = join(process.cwd(), "dist", "assets");

function findMatchingBrace(css, openIndex) {
  let depth = 0;
  let quote = "";
  let escaped = false;
  let inComment = false;

  for (let i = openIndex; i < css.length; i += 1) {
    const char = css[i];
    const next = css[i + 1];

    if (inComment) {
      if (char === "*" && next === "/") {
        inComment = false;
        i += 1;
      }
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }

    if (char === "/" && next === "*") {
      inComment = true;
      i += 1;
      continue;
    }
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }

  throw new Error(`Unmatched CSS brace at ${openIndex}`);
}

function isIdentifierChar(char) {
  return /[a-zA-Z0-9_-]/.test(char ?? "");
}

function unwrapCascadeLayers(css) {
  let output = "";
  let i = 0;
  let quote = "";
  let escaped = false;
  let inComment = false;

  while (i < css.length) {
    const char = css[i];
    const next = css[i + 1];

    if (inComment) {
      output += char;
      if (char === "*" && next === "/") {
        output += next;
        inComment = false;
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    if (quote) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = "";
      }
      i += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      output += char + next;
      inComment = true;
      i += 2;
      continue;
    }
    if (char === "\\") {
      output += char;
      if (next) {
        output += next;
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      output += char;
      quote = char;
      i += 1;
      continue;
    }

    if (
      css.startsWith("@layer", i) &&
      !isIdentifierChar(css[i - 1]) &&
      !isIdentifierChar(css[i + 6])
    ) {
      let cursor = i + 6;
      while (/\s/.test(css[cursor] ?? "")) cursor += 1;
      while (cursor < css.length && css[cursor] !== "{" && css[cursor] !== ";") cursor += 1;

      if (css[cursor] === ";") {
        i = cursor + 1;
        continue;
      }

      if (css[cursor] === "{") {
        const close = findMatchingBrace(css, cursor);
        output += unwrapCascadeLayers(css.slice(cursor + 1, close));
        i = close + 1;
        continue;
      }
    }

    output += char;
    i += 1;
  }

  return output;
}

const entries = await readdir(distAssets, { withFileTypes: true });
let changed = 0;

for (const entry of entries) {
  if (!entry.isFile() || !entry.name.endsWith(".css")) continue;
  const file = join(distAssets, entry.name);
  const original = await readFile(file, "utf8");
  const compat = unwrapCascadeLayers(original);
  if (compat !== original) {
    await writeFile(file, compat, "utf8");
    changed += 1;
    console.log(`[android-css-compat] flattened cascade layers in ${entry.name}`);
  }
}

if (changed === 0) {
  console.log("[android-css-compat] no cascade layers found");
}

import type { Plugin } from "vite";

function findMatchingBrace(css: string, openIndex: number) {
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

  return css.length - 1;
}

function isIdentifierChar(char: string | undefined) {
  return /[a-zA-Z0-9_-]/.test(char ?? "");
}

function unwrapCascadeLayers(css: string): string {
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

export function androidCssCompatPlugin(enabled: boolean): Plugin | undefined {
  if (!enabled) return undefined;
  return {
    name: "baas-android-css-compat",
    enforce: "post",
    transform(code, id) {
      if (!id.includes(".css")) return undefined;
      const viteCssModule = code.match(/(const __vite__css = )("(?:(?:\\.|[^"\\])*)")/);
      if (viteCssModule) {
        try {
          const css = JSON.parse(viteCssModule[2]) as string;
          const compatCss = unwrapCascadeLayers(css);
          if (compatCss === css) return undefined;
          return {
            code: code.replace(viteCssModule[0], `${viteCssModule[1]}${JSON.stringify(compatCss)}`),
            map: null,
          };
        } catch {
          return undefined;
        }
      }

      const compat = unwrapCascadeLayers(code);
      if (compat === code) return undefined;
      return { code: compat, map: null };
    },
  };
}

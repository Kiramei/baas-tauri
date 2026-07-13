import type { Plugin } from "vite";

const nonAsciiPattern = /[^\x00-\x7F]/g;

/** Handles the escape non ascii workflow. */
const escapeNonAscii = (code: string): string =>
  code.replace(nonAsciiPattern, (char) =>
    [...char]
      .map((part) =>
        part
          .codePointAt(0)!
          .toString(16)
          .padStart(4, "0")
      )
      .map((hex) => (hex.length > 4 ? `\\u{${hex}}` : `\\u${hex}`))
      .join("")
  );

/** Handles the ascii js output plugin workflow. */
export const asciiJsOutputPlugin = (enabled: boolean): Plugin | undefined => {
  if (!enabled) return undefined;

  return {
    name: "baas-ascii-js-output",
    /** Handles the generate bundle workflow. */
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type === "chunk") {
          output.code = escapeNonAscii(output.code);
        } else if (output.fileName.endsWith(".js") && typeof output.source === "string") {
          output.source = escapeNonAscii(output.source);
        }
      }
    },
  };
};

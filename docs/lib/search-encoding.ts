import type { EncoderOptions } from "flexsearch";

// Keep Han character search while indexing Latin identifiers and numbers as terms.
export const chineseSearchEncoder: EncoderOptions = {
  split: /([\p{Script=Han}])|[^\p{L}\p{N}_]+/u,
  numeric: false,
  dedupe: false,
};

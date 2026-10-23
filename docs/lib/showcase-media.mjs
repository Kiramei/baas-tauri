import assets from "./showcase-assets.json" with { type: "json" };

export function showcaseMedia(src) {
  if (!src.startsWith("/media/desktop/")) return src;
  const url = new URL(src, "https://docs.invalid");
  const replacement = assets[url.pathname];
  return replacement ? replacement + url.search + url.hash : src;
}

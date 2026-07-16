export const docsBasePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/$/, "");

/** Prefixes one root-relative public asset with the configured Pages mount. */
export function withDocsBasePath(path: string): string {
  if (
    !docsBasePath ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path === docsBasePath ||
    path.startsWith(`${docsBasePath}/`)
  ) {
    return path;
  }
  return `${docsBasePath}${path}`;
}

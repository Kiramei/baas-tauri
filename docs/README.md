# Documentation

The bilingual Fumadocs site lives in `content/docs/{en,zh}`. Keep the two language trees and their `meta.json` navigation in sync.

## Build and Preview

From the repository root:

```sh
bun install --frozen-lockfile
cd docs
bun install --frozen-lockfile
bun run build
```

Serve `docs/out` with a static server. For authoring, run `bun run dev` inside `docs`. The export is deployed at the site root; the supported public entry is https://baas.kiramei.moe.

## Validation

From the repository root:

```sh
bun test docs/tests
node docs/scripts/convert-public-media.mjs
node docs/scripts/check-static-links.mjs
```

Browser checks require Playwright. Set `PLAYWRIGHT_MODULE` when it is installed outside the repository. `.github/workflows/docs-validation.yml` contains the Linux static-export checks and their browser setup. Run affected source-bound checks after rebuilding; do not substitute edited hashes for a browser run.

## Content and Media

- User guides belong under `content/docs`, not in root-level progress reports.
- Keep current behavior separate from historical APK, benchmark, and screenshot results. A source inspection is not a device test.
- Public raster images and animations use WebP. Desktop showcases use the application's dark theme; site themes remain independently selectable.
- Review text and every published image frame for account data, credentials, private paths, and device identifiers. Use local Gaussian blur on sensitive image regions and retain proof that pixels outside those regions are unchanged.
- Keep raw captures, OCR text, personal runtimes, APKs, and temporary reports outside tracked/public paths.
- `evidence/` and `public/benchmarks/` contain sanitized, source-bound fixtures used by tests. Do not remove them as temporary work logs.
- Publication and capture manifests retain source revision, media hashes, and privacy review provenance. Do not relabel historical media as a new build.

## Useful Pages

- [Release policy](development/RELEASING.md)
- [Chinese manual](content/docs/zh/index.mdx) / [English manual](content/docs/en/index.mdx)
- [WebUI deployment](content/docs/en/guide/webui.mdx)
- [Plugin API](content/docs/en/reference/plugin-api.mdx)
- [Client architecture](content/docs/en/reference/client-architecture.mdx)
- [Development](content/docs/en/reference/development.mdx)

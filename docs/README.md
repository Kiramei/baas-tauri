# BAAS Documentation Site

This directory contains the Fumadocs documentation site for BAAS Tauri.

```bash
bun install
bun run dev
bun run build
```

Local routes:

- `http://localhost:3000/docs/zh/`
- `http://localhost:3000/docs/en/`

Content:

- `content/docs/zh`: Simplified Chinese documentation.
- `content/docs/en`: English documentation.
- `public/cn`: Chinese UI screenshots.
- `public/en`: English UI screenshots.

GitHub Pages deployment uses `.github/workflows/wiki-pages.yml`. The workflow passes `NEXT_PUBLIC_BASE_PATH` from `actions/configure-pages`, builds static output into `docs/out`, and uploads it to Pages.

Screenshot rule: identify the screenshot's actual UI before using it. Do not insert unrelated screenshots just to decorate a page.

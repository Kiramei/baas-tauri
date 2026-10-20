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

## Current refresh

`refresh-audit.md` tracks the complete dev/Android refresh, including unfinished
requirements. `docs/dev-refresh` is based on desktop `dev`; Git cannot also have
a `dev/docs` branch while the `dev` ref exists. Keep application edits in their
own worktrees.

The `/` and `/docs/` entries use a saved language choice, then browser languages,
with English fallback. Explicit localized URLs retain their language. Relative
MDX links resolve from the source file directory through `remarkDocLinks`, not
from the exported URL's trailing slash. Keep links inside their language tree.

Validation from `docs/`:

```powershell
bun test tests
bun run build
```

Optional browser checks from the repository root, with a static server serving
`docs/out` at port 4173:

```powershell
node docs/scripts/check-static-links.mjs
node docs/scripts/smoke-docs.mjs http://127.0.0.1:4173
```

Browser tools require Playwright and a local Microsoft Edge installation.
`PLAYWRIGHT_MODULE` may point to an already installed Playwright module; no
particular machine's dependency path is hard-coded in the scripts. Evidence and
review screenshots are written under `.cache/docs-smoke`.

`scripts/capture-desktop.mjs` targets the isolated native release WebView on
loopback DevTools port 19230. `scripts/capture-android.mjs` targets the installed
Android WebView forwarded to a supplied port and requires a selected
`Documentation Demo` profile. Pass verified installed-APK provenance as the
second argument, for example
`node docs/scripts/capture-android.mjs 19233 docs/evidence/android-x86-provenance.json`.
These are native app captures with real backends,
not frontend fixture renders. Review the profile and script assumptions before
using them on another environment. Capture manifests distinguish verified
installation/navigation from unverified game execution. The current ARM64 ABI
failure and fresh matching x86_64 build are recorded separately under `evidence/`.

`scripts/record-workspace.mjs` records a real configuration toggle and undo;
`scripts/encode-demo.py` requires Pillow to encode those frames. The website
starts on a still frame and lets readers start/stop the GIF. Published app
captures use light mode; docs remain independently light/dark.

Reproduce the frontend microbenchmarks with
`bun docs/scripts/measure-frontend.ts` from the repository root. Preserve the raw
record, source revision, environment and scope. Do not interpret encoding/store
preparation measurements as game or full-application speedups.

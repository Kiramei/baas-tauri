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

`scripts/capture-workspaces.mjs 19230` records actual profile/settings/log dialogs
in the isolated desktop demo without confirming destructive operations or saving
new hotkeys. The actual global shortcut recorder temporarily suspends/restores
existing OS registrations. `scripts/capture-remote.mjs 19230` records a real
desktop remote-preview connection to the emulator, then closes it; preview pixel
probes demonstrate decoded UI frames, not game execution or remote-input success.
Their manifests list the actions taken and validation limits. The compiler-API
test for `evidence/workspaces-coverage.json` checks settings/shortcut/command
coverage, not backend behavior or the semantic accuracy of every paragraph.

`scripts/record-workspace.mjs` records a real configuration toggle and undo;
`scripts/encode-demo.py` requires Pillow to encode those frames. The website
starts on a still frame and lets readers start/stop the GIF. Published app
captures use light mode; docs remain independently light/dark.

Reproduce the frontend microbenchmarks with
`bun docs/scripts/measure-frontend.ts` from the repository root. Preserve the raw
record, source revision, environment and scope. Do not interpret encoding/store
preparation measurements as game or full-application speedups.

## Media Privacy Checks

Use demo data with empty credentials. Sensitive image fields use local blur.
Keep capture notes and validation limits in manifests and this audit, outside
reader-facing instructions. Do not publish original unblurred captures or OCR
text. The installer capture applies temporary inline blur and checks the
computed filter, including low-effects mode and visible tooltip commands.
Restore the temporary styles even if capture fails.

Two legacy images have local Gaussian blur baked into their PNG pixels. Run
`node docs/scripts/blur-private-media.mjs` from the repository root to verify
their recorded output hashes; it skips already processed files and refuses
unknown source hashes. The source/region plan is in the script, and
`evidence/legacy-media-blur.json` records dimensions, source/output hashes,
changed-pixel counts, zero changes outside the regions and visual review.
Original unblurred media is not copied into public output. Changes require
fresh visual review and OCR; changing a hash alone cannot clear a finding.

`scripts/capture-installer.mjs 19235 failed en` captures the deliberately missing
entrypoint scenario in a disposable backend. The `completed` scenario reuses an
existing backend and custom Python. Neither proves a fresh download or managed
dependency installation. Review the runtime and locale before calling it; it
must never remove files from a shared backend. The script does not prepare the
failure itself or start task execution.

From the repository root, Windows OCR can inspect every raster image/GIF frame
locally without uploading media:

```powershell
powershell.exe -NoProfile -File docs/scripts/audit-media-privacy.ps1 -Root docs/public -Output .cache/docs-privacy/all-public-ocr.json
node docs/scripts/summarize-media-privacy.mjs
```

The first command requires the Windows Simplified Chinese OCR language pack.
Its raw OCR text stays in ignored `.cache/`. The second checks image hashes and
inventory freshness, then saves only counts, a digest and reviewed findings to
`evidence/privacy-review.json`. Two visually reviewed generic emulator-path
placeholders are allowed by exact image hash. Changed media needs a new scan
and review; OCR can miss names, QR codes, private hosts and illegible text.
Tests reject stale inventory evidence and private local workspace paths in
published JSON/MDX. These checks do not certify complete anonymization.

## Native Transport Benchmark

`scripts/measure-native-transport.mjs CDP_PORT DISPOSABLE_PORTABLE_ROOT` measures
the running release app's existing production store, discovered from the cached
entry-module exports. It does not load a second store, modify app source or run
game tasks. Before running, verify the runtime ownership, executable provenance,
single disabled demo profile and completed app synchronization. It restarts the
owned backend for each mode and restores the original mode in `finally`.
It must not be used against shared/user installations.

The six mode permutations produce 18 rounds, 300 measurements and 50 warm-ups
per mode/round, with one outstanding status request. All production callbacks
have the same empty result; their 44-byte JSON size excludes the wire envelope.
Individual timestamps and blocks have different boundaries. The observed
WebView clock quantum is recorded; native startup/switching is separate from
request timing. Background host activity is not controlled by the harness.

`node docs/scripts/publish-native-benchmark.mjs` validates the local record and
writes the sanitized public dataset. Inspect the record before publication.
The validator/tests recompute statistics from every raw sample and reject missing
samples, failed attempts, changed response sizes or incomplete restoration.
Source and executable hashes stay with the result. This experiment is a small
production RPC comparison, not screenshot/input/game performance or a general
carrier-throughput ranking. Those measurements remain separate work.

The measurement snapshots its harness/statistics SHA-256 before sampling.
Publication compares those stored hashes with the current files and rejects
drift. Preserve an older record before rerunning a changed harness; do not bind
new source hashes to old samples during publication.

## Device Capture Probe

`scripts/probe-device-capture.mjs` uses a temporary tagged canvas in the owned
Android demo WebView and the unmodified desktop Python capture adapters. Its
arguments are CDP port, disposable backend root, Python executable, ADB serial
and MuMu launcher. The preflight checks the forwarded WebView PID's actual
package, foreground app and installed APK hash. Tauri's configured identifier
can differ from the Gradle application ID; do not use it alone as package proof.

The probe sends no input. Fixture ownership prevents cleanup from removing
another run's overlay. Normal cleanup and a ten-minute expiry remove the canvas.
`scripts/check-device-fixture.mjs` separately tests trusted/untrusted pointer
behavior, target bounds and underlay restoration in a desktop browser. Its
results are not Android input latency. Python array validation tests run with:

```powershell
python -m unittest discover -s docs/tests -p test_device_capture_probe.py -v
```

The first two probe runs returned correct tagged 720x1280 frames from ADB,
Scrcpy and Nemu. Stock uiautomator2 reached the Android BAAS local bridge at
device port 7912 and received 403 instead of an image. The unauthenticated
version marker and direct-device TCP diagnostic identify that service, including
when the host HTTP proxy is bypassed. Do not remove authentication, extract
tokens, stop another task's agent or classify this as an Android-version limit.
Use a separate target/service owner before a comparative uiautomator2 run.

`scripts/diagnose-device-service.py SERIAL PACKAGE` emits safe service metadata;
write its output to `.cache/docs-benchmarks/device-service-diagnostic.json`.
`scripts/publish-device-probe.mjs` preserves source/environment and compatibility
findings in `evidence/` while omitting single initialization/capture timings.
Original outputs and diagnostic logs remain in ignored `.cache/`. They must not
be ranked as steady-state capture results. The bundled Scrcpy adapter writes
its standard jar under `/data/local/tmp` and owns a fixed abstract socket; the
probe refuses an already occupied socket and closes its own session afterward.

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

### Static Deployment Checks

`scripts/check-deployment.mjs` starts its own loopback-only static host, with no
SPA fallback or special route-file aliases. It checks every content route in
both languages, themes and viewport sizes, plus font loading, screenshot
framing, GIF playback, image zoom, client navigation, search, language switching
and entry query/hash preservation. Missing resources and reload fallback fail
the check.

To export a prefixed copy without replacing the existing `out` preview, run
from `docs/` in PowerShell:

```powershell
$env:NEXT_PUBLIC_BASE_PATH = "/baas-tauri"
$env:DOCS_EXPORT_DIR = ".cache/deployment-prefixed"
bun run build
node scripts/check-deployment.mjs --out docs/.cache/deployment-prefixed --base-path /baas-tauri
Remove-Item Env:NEXT_PUBLIC_BASE_PATH, Env:DOCS_EXPORT_DIR
```

`--out` is relative to the repository root. The script supports
`--channel chromium` for a Playwright-managed browser. Its reports and screenshots
are stored in the ignored repository `.cache/deployment/` directory. The
`Validate Documentation Export` workflow runs root and prefixed exports on Linux
for documentation branches and pull requests. It has read-only repository
permissions and uploads test evidence without deploying Pages.

Navigation links are resolved to unprefixed app routes because Next Link adds
`basePath`. Media URLs and metadata icons include the prefix explicitly. Font
and cursor URLs are relative CSS dependencies, so the bundler emits their
deployment-aware asset paths. See the official [basePath](https://nextjs.org/docs/app/api-reference/config/next-config-js/basePath)
and [assetPrefix](https://nextjs.org/docs/app/api-reference/config/next-config-js/assetPrefix)
references for that distinction.

`DocumentationLink` renders local public files as ordinary prefixed anchors.
This prevents raw benchmark records from being prefetched as document routes.
Document, entry, fragment and external links retain the framework's navigation
behavior.

The build also checks every prerendered page's segment manifest against Next's
canonical static-export filenames. Next 16.2.9 can emit nested segment paths on
Windows while its client requests dotted filenames. `normalize-static-export.mjs`
adds missing canonical files directly from the corresponding build payloads,
without altering their bytes or overwriting conflicting output. Already-correct
exports are unchanged. Missing sources, unsafe paths and conflicting payloads
fail the build. The strict host applies no filename aliases to conceal errors.

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
carrier-throughput ranking. Device measurements and the larger JSON workload
are reported independently below. Binary-image transport remains unmeasured.

The measurement snapshots its harness/statistics SHA-256 before sampling.
Publication compares those stored hashes with the current files and rejects
drift. Preserve an older record before rerunning a changed harness; do not bind
new source hashes to old samples during publication.

## Large Config Synchronization Benchmark

`scripts/measure-native-payload.mjs CDP_PORT DISPOSABLE_PORTABLE_ROOT` uses the
same ownership/executable/idle-demo guards, then calls the existing production
sync Store. It temporarily adds synthetic ASCII fields, retaining a byte-exact
private config/event backup. Every full snapshot must equal the expected config.
One pull is outstanding; unexpected config updates abort the block. Production
pulls have no echoed request ID, so the idle-channel assumption is part of the
measurement boundary, not a concurrency guarantee.

The formal run contains 54 blocks: six balanced transport orders, three modes
and three rotating payload sizes. Each block has 20 warm-ups and 100 measured
requests. Notification timing and 20-call block timing have different endpoints.
The latter includes full-content validation; neither is a game or image test.
The `--probe` option exercises the path with a small sample set and cannot pass
the publication gate as a formal comparison.

The first private probe exposed a release Store cleanup detail: a remove push
refreshes the config list without deleting fields in its cached config. Cleanup
now pulls a full snapshot before and after removing synthetic fields. The failed
probe remains separate; a corrected preflight and formal run restored the exact
config/event bytes, Store content and original SHM mode. Do not reclassify failed
probes as formal samples.

From the repository root, publication takes the raw timestamped record, the same
portable runtime and a backend Git checkout:

```powershell
node docs/scripts/publish-native-payload.mjs RAW_REPORT PORTABLE_ROOT BACKEND_GIT_CHECKOUT
node docs/scripts/check-native-payload.mjs
```

The publisher checks measured harness hashes, executable provenance and every
recorded runtime source against Git objects, with CRLF/LF normalization. It
writes the full public record plus a hash-bound compact chart summary, so the
client does not embed all raw samples. The browser check owns a temporary strict
static host and verifies 48 control states plus eight native raw-record links
across both languages, themes and viewport sizes. `--base-path`, `--export-dir`
and `--channel` support the Linux/root/prefix matrix without a routing fallback.
Its report binds source, data and exported HTML hashes. Source changes require
rerunning browser checks, not hand-editing the recorded digests.

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

## Device Performance Measurement

The independent native target is in `benchmarks/device-target/`; its README
describes the surface, build and ownership checks. `scripts/measure-device.py`
uses the actual production desktop adapters and writes raw diagnostics into
ignored `.cache/`. It starts a standard atx-agent 0.10.0 (386 on this emulator)
and the existing uiautomator 2.3.3 test service, without replacing installed APKs.
The target is separate from the owned BAAS Android application.

Required arguments are `--backend`, `--serial`, `--emulator`, `--apk`, `--output`
and optionally `--cdp-port` (19233). Paths to the Python environment and
Playwright must already be available. The backend must match its recorded
revision. Run without `--measure` for tagged-frame/click probes only; add
`--measure` for the balanced 32 capture and 48 input blocks. Never use normal
profiles or a device with another automation service running.

Capture calls exclude initialization, validation and the script screenshot
interval. Control calls preserve production sleeps and use a common decoded
Scrcpy observer. Foreground and target-state checks happen outside timing.
Warm-ups, failed attempts, frame counters, region MSE, received press duration
and travel remain in the record. The observer's own decoding samples are also
retained. There is no game-success claim.

After a complete restored run:

```powershell
node docs/scripts/publish-device-benchmark.mjs .cache/docs-benchmarks/device-measurement-second.json ../backend-source ../benchmark-runtime
```

The publisher verifies sample counts/order, source/target hashes, exact pinned
Git content (normalizing Python CRLF), input results and restoration. It emits
sanitized raw data at `public/benchmarks/device-current.json` and a compact
hash-bound `evidence/device-summary.json` for the interactive charts. The client
bundle does not import every raw sample. Editing the measurement harness or
demo inspector after sampling requires a new run, not new provenance for old
samples.

`scripts/record-device-environment.ps1 -NemuSdkPath PATH_TO_SDK_DLL` records a
separate post-run CPU/memory/Windows inventory and SDK digest. The public
`benchmarks/device-environment-audit.json` is bound to the raw record hash and
excludes host paths and machine identifiers. Its timestamp is explicit: the SDK
digest was collected after sampling, and missing PE version fields stay null.
File timestamps alone are not proof of unchanged binaries during the run.

## Conditional Configuration Capture

`scripts/capture-conditional-config.mjs PLATFORM CDP_PORT DISPOSABLE_BACKEND PYTHON [ADB_SERIAL]`
uses the existing authenticated native store and the real UI. The desktop demo
must be named `Schale Demo`; Android uses `Documentation Demo`. All 26 demo
tasks must be disabled, every scheduler idle and all profiles' autostart off.
The script checks the portable runtime/executable or installed APK and forwarded
WebView ownership before changing the demo. Never pass a normal runtime.

Backups stay in ignored `.cache/docs-conditional/`. Only the listed demo fields
are patched through the production `modify` API, waiting for provider data.
The script captures both UI languages in light mode, exercises conditional
tabs, selectors, validation and history, then restores the original fields,
compares other profiles and verifies unchanged demo events. `finally` attempts
restoration even after a failed assertion. A report is publishable only with
`scenariosCompleted`, `restored`, ownership and comparison checks all true.

Each locale starts with a fresh WebView history, since the UI intentionally
retains local drafts across category navigation. Reload may show the owned
desktop installer's completed screen; the script enters Home only after its
normal completion. Android reloads emitted transient stale Tauri callback
errors in this run; subsequent authentication, configuration ACKs and restore
checks passed. These errors are not claimed fixed by this docs work.

The `conditional-*` screenshots include deliberately invalid `legacy-plan`,
`legacy-count` and `250-9` examples. No Execute/Start control is used. Crops show
the native visible panel/modal; Android uses the native viewport. Sensitive
path/IPC/credential fields receive local blur before PNG encoding. The priority
GIFs use 21 captured source frames at 160 ms playback intervals; the encoder
coalesces repeated still frames. They demonstrate interaction, not latency.

The platform manifests bind every image/GIF and the capture script to SHA-256.
Changing the script requires recapture, not rebinding an old result to new code.
After capturing, repeat the whole-public privacy scan and summary. Run
`scripts/check-conditional-docs.mjs` against the built preview for all 56 page/
locale/theme/viewport combinations and eight play/stop checks; screenshots stay
in ignored cache, with safe result metadata in `evidence/`.

## Backend Reference and Recognition Replay

The bilingual backend-development guide follows the service path, including
startup/task injections, session initialization, cooperative stop, the core
recognition loop, coordinate/OCR boundaries and top-level configuration
migration. Direct legacy `main.py` examples can run game tasks; use the service
entry point for development and separate data from a live instance.

`scripts/replay-backend-recognition.py BACKEND` reads the pinned Git revision and
compares every audited file with its Git object, normalizing CRLF only. It
extracts the unmodified `co_detect`, `match_img_feature` and exception ASTs,
without importing device modules. Deterministic capture, matcher, loading,
popup, clock and click adapters record twelve branch scenarios. These are not
real-frame recognition, device input or performance samples. Do not convert
the fake clock values into latency claims.

The output is `public/developer/recognition-replay.json`; its replay-script
hash and source hashes prevent accidental source drift. The UI uses these
recorded events, not a second JavaScript implementation of the recognizer.
`scripts/check-recognition-replay.mjs` exercises all scenarios and every step
across both languages, themes and viewport sizes; review the cached screenshots.

For an isolated backend test run, export the pinned commit into a new ignored
cache directory. Never run its mutable tests in another task's checkout. Run
the service suite, core task-retry test and OCR tests there, retaining JUnit in
cache. Optional `--tested-source SNAPSHOT --junit REPORT` arguments to the replay
publisher verify audited and tested snapshot files against Git and create
`evidence/backend-development-validation.json`. The JUnit digest, counts and
skip reasons are published, without raw logs or local paths. Package metadata
is collected afterward using the configured test interpreter; a null package
version means that distribution's metadata is unavailable. This does not prove
a fresh install or all supported Python/platform combinations.

## Android Game Placement Probe

`scripts/probe-android-game.mjs start|snapshot|close LABEL` targets only the
hash-verified documentation x86 APK and Bilibili game on serial
`127.0.0.1:16384`, with its owned WebView forwarded on 19233. Keep the owned
BAAS Activity foreground when attaching CDP. All schedulers must be idle,
autostart off and all 26 Documentation Demo events disabled. Start also refuses
an existing display, running game or prior baseline in the same cache run.

Set `ANDROID_GAME_PROBE_RUN` to a new lowercase identifier for each independent
run. Start backs up configuration/events before clicking the actual Home game
play button. It deliberately leaves the display running for inspection. It does
not start a scheduler, inject game input, change Shizuku mode or clear game
data. Always restore before leaving the session: bring this owned BAAS Activity
back, return the game started by this probe to its initially stopped state,
then run close with the same run identifier. Never stop another game's or
another client's process to satisfy a precondition.

Close dispatches the production native-overlay event handler and invokes
idempotent native cleanup; this is not proof of physically tapping a native
button. It restores the four local-connection fields, compares every profile
and event against the baseline, checks the idle Home button and verifies the
game is stopped. Raw screenshots, profile backups and system dumps remain in
ignored `.cache/android-game-session/`; they are not publication assets.

`scripts/summarize-android-game.mjs RUN ANDROID_SOURCE` validates the captured
placement denial, actual Activity display, display flags, PNG digest/pixels,
unchanged capture harness, pinned source files and restoration. It emits only
allowlisted metadata in `evidence/android-game-validation.json`. Android version
properties are checked afterward and labeled as post-run observations. The
current result is a failed shell-mode game-display placement, not successful
Android automation, a fixed APK or a performance result. Changing the capture
script requires a new run. The suspected trusted-display cause remains a
hypothesis until a repaired build is tested.

## Service Protocol Reference

The Service/CLI guides describe control authentication, business resume,
Cookie/session expiry, patch acknowledgment/conflict, binary ordering, local
framing and deployment boundaries. The fixed public signing seed and existing
business-stream behavior after password revocation are documented limitations,
not claims that this refresh repaired application security.

Run `node docs/scripts/probe-service-protocol.mjs BACKEND_GIT SNAPSHOT PYTHON`
from the repository root. The snapshot must be under ignored `.cache/` and match
the pinned backend. Bun only bundles the existing client module; Node drives
Playwright. The Python fixture binds an ephemeral loopback port, creates its own
temporary auth/config directory and uses production auth, HTTP remember/logout,
Provider, Sync and ConfigManager code. Runtime status/log queues are deterministic
adapters. It excludes Trigger, Remote, Android and system-log routes and never
starts ServiceContext, OCR, device adapters or game tasks.

Twenty browser cases exercise actual production crypto without replacing KDFs,
the default matching pin, login/remember/logout and config conflicts. One case
deliberately ignores client revocation handling to verify the current existing-
stream limitation. The report verifies 69 backend and four client source hashes,
binds both harnesses and the browser bundle, and checks graceful fixture exit
and removal of that run's private directory. Credentials and raw diagnostics
stay out of committed evidence. Earlier stalled/incomplete attempts are not
accepted; their exploratory files may remain in ignored cache.

`scripts/summarize-service-contracts.py BACKEND_GIT SNAPSHOT JUNIT` verifies the
seven focused backend contract test files and publishes their counts, skip and
JUnit hash. It also runs only `main.service.py --help` and mutually-exclusive
option rejection in a separate ignored directory. It never imports or runs
`cli.example.py`. Several backend unit tests mock KDFs, unlike the independent
browser interoperability cases. Neither proves TLS deployment, fresh dependency
installation, complete native recovery or actual game execution.

After building, `scripts/check-service-docs.mjs` checks both pages in all eight
locale/theme/viewport combinations, 16 diagram zoom/reset interactions and four
localized search navigations. Cached screenshots are for review; no new public
media is generated. Rebuild/recheck after changing these pages or the renderer.

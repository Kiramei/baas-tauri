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
- `public/media/desktop/{zh,en}`: current desktop UI WebP captures.
- `public/media/android/{zh,en}`: current Android UI WebP captures.
- `public/backend-assets`: referenced game/system examples and developer diagrams.

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
framing, animated WebP playback, image zoom, client navigation, search, language switching
and entry query/hash preservation. Missing resources and reload fallback fail
the check.

`--out` is relative to the repository root. The script supports
`--channel chromium` for a Playwright-managed browser. Its reports and screenshots
are stored in the ignored repository `.cache/deployment/` directory. The
`Validate Documentation Export` workflow checks the root-path export on Linux
for pull requests and pushes to `dev` or `main`. It has read-only repository
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

The retained legacy game screenshot has local Gaussian blur baked into its
pixels, preserved by lossless WebP publication. The older CVAT example was
removed with other unused assets. Run
`node docs/scripts/blur-private-media.mjs` from the repository root to verify
the recorded blur/publication hashes; it skips already processed files and refuses
unknown source hashes. The source/region plan is in the script, and
`evidence/legacy-media-blur.json` records dimensions, source/output hashes,
changed-pixel counts, zero changes outside the regions and visual review.
The original blur evidence retains both historical files; only referenced
outputs are published. Unblurred media is not copied into public output. Changes require
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
node docs/scripts/summarize-media-privacy.mjs .cache/docs-privacy/all-public-ocr.json
```

The first command requires the Windows Simplified Chinese OCR language pack.
Its raw OCR text stays in ignored `.cache/`. The second checks image hashes and
inventory freshness, then saves only counts, a digest and reviewed findings to
`evidence/privacy-review.json`. Two visually reviewed generic emulator-path
placeholders are allowed by exact image hash. Changed media needs a new scan
and review; OCR can miss names, QR codes, private hosts and illegible text.
Tests reject stale inventory evidence and private local workspace paths in
published JSON/MDX. These checks do not certify complete anonymization.

## Published Media

Published raster assets use WebP, including controlled animated WebP demos.
`node docs/scripts/convert-public-media.mjs` verifies the full current inventory,
encoded digests, visible RGBA digests, dimensions, frame delays and loop counts.
`evidence/webp-publication.json` records the lossless publication transform.
Fully transparent RGB differences are counted separately; visible pixels are
unchanged, including existing Gaussian-blurred regions. Metadata is stripped.

Capture manifests and benchmark records retain their original file names,
source hashes, timestamps and implementation identities. They describe the
original capture, not a fresh WebP capture. Use `scripts/published-media.mjs`
to resolve a historical capture to the reviewed public encoding. Do not replace
original source hashes with WebP hashes or relabel old performance samples.
Raw originals remain outside the public output and Git's new files.

Unused legacy client captures in `public/cn` and `public/en` have been removed.
Troubleshooting and PC-client settings now use current light-theme captures.
Only referenced game/system examples and developer diagrams remain under
`backend-assets`. Recheck page references and browser rendering before removing
another asset; filename age alone does not establish that it is unused.

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

## Android Local Benchmark

`scripts/measure-android-local.mjs --serial DEVICE --native-root CHECKOUT`
requires the exact isolated APK/source revision pinned in that harness, the
installed native fixture, an idle authenticated demo with all 26 events off,
no existing game/fixture process and no active display/updater workflow. It
refuses a leftover measurement directory instead of overwriting instrumentation.
Obtain permission before interrupting any current game/scheduler session.

The harness temporarily disables idle updates and adds a startup hook only to
the owned downloaded backend's `service/__init__.py`. The worker runs production
adapters in the real embedded Python process, without replacing their methods.
The game is launched only to prepare the production display path, then stopped;
all input targets the account-free native fixture. The small `--probe` run is
separate from the 400 screenshot / 216 input formal run and cannot be published.

The first probes retained a theme precondition failure and a WebView-reload
failure. The latter required explicit private entrypoint/state recovery before
retrying. Startup now rediscovers the authenticated Store after reload; cleanup
restores the owned disk entrypoint before waiting for a WebView, then reconnects
to close the display and restore configs/events/UI preferences. Failed reports
remain separate. Never relabel them as successful samples or leave a hook active.

Publication from the repository root:

```powershell
node docs/scripts/publish-android-local.mjs RAW_RUN_DIRECTORY NATIVE_CHECKOUT
node docs/scripts/check-android-local.mjs
```

The publisher verifies normalized measured harness hashes, five native Git
objects, the built APK bytes, target sources and embedded worker identity.
The APK's nested requirements archive supplies the Pillow metadata/version.
Downloaded backend fingerprints remain distinct from the APK source revision;
publication does not invent a backend Git revision for an archive installation.
The full sanitized record retains all 616 formal calls and 86 warm-ups, while
the client imports only its hash-bound compact summary. Temporary tokens, host
paths, process identities, user configs and raw traceback text stay private.

The browser check owns a strict temporary server and validates 64 control states
and eight byte-identical raw-record links across both languages/themes/viewports.
`--export-dir`, `--base-path` and `--channel` select the export and browser to check.
The Python offline tests cover decoding, texture arithmetic, timing endpoints,
gesture checks and probe/formal counts. None of this establishes game-task
acceptance or cross-device performance. App preferences may remain dark for
non-media measurements; published application captures still use light mode.

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

## Search Artifact Coherence

The root layout and static JSON route share `getSearchArtifact()`. Each export
publishes one `search-index/<revision>.json`; its content address includes the
serialized indexes and a format descriptor covering the Chinese encoder.
The page passes that revision/URL to its dialog and exposes the URL in the
`baas-search-index` meta tag. The unversioned `search-index.json` endpoint is
removed so old clients cannot import a new encoder's data through that address.

The client checks the envelope revision and format before importing chunks.
This is deployment/cache coordination, not a signature or an adversarial
content-integrity guarantee. Successful imports are shared by URL and expected
revision. Failed imports are evicted; fresh downloads use `no-store`. A missing
or mismatched artifact offers an explicit document reload, while transient
network/JSON errors retain the existing retry controls. Reload preserves the
document URL and persisted language/theme. An already open older client can
require a full page reload after deployment.

After building, `check-search-cache.mjs` owns a strict local static host and
checks 24 locale/theme/viewport/scenario combinations. The old-address and
old-revision fixtures have long-lived cache headers; repeated fetches must
produce one HTTP request each, proving browser caching is active. Current-page
queries must use their own artifact and exclude the old marker. Separate 404
and wrong-revision responses must recover through the localized reload button
or Enter, with exactly one new download after reload. These controlled failures
do not reproduce historical clients' JavaScript or establish the cause of the
separate intermittent result-click timeout.

Run it with `--out OUT --base-path PREFIX --channel msedge` for a local export;
the Linux matrix uses Chromium. `--report docs/evidence/search-cache-validation.json`
publishes the root report; every run also retains its report/screenshots under
ignored deployment cache. `read-search-artifact.mjs` validates the filename,
payload revision and recomputed content digest. Existing recovery/updater/service
checks now bind the actual versioned file. Deployment checks verify every page's
meta URL and reject an accidentally retained unversioned endpoint.

## Android Preview Source and Browser Checks

The bilingual Android guide and client architecture distinguish capture, EGL
submission and TextureView consumption. Source links use the measured APK's
`36f08fd3` revision; the updater installer reference also uses this revision
because preview changes shifted its lines. Run `audit-updater-source.mjs` to
compare the referenced files with their pinned Git objects. The older updater
references remain pinned separately where their files are unchanged.

After building, run `check-android-docs.mjs BASE_URL` against the exported site.
Alongside the existing media/diagnostic checks, it follows the guide's pipeline
link in eight locale/theme/viewport combinations, verifies nine rendered nodes
and all three counters, exercises zoom/reset and scrolling to the final node,
and checks page overflow.
`evidence/android-preview-layout.json` binds those checks to the diagram,
guide, renderer and harness sources. These are documentation browser checks;
they do not operate the emulator or measure native preview frame rate.

The Android-local raw dataset still contains the original 400 capture and 216
input calls. Source inspection and diagrams add no new timing samples and do
not resolve the remaining game startup/preview stability failures.

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

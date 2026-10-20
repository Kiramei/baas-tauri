# Documentation refresh audit

This ledger preserves the full requested scope. **The refresh is not complete.**
The current checkpoint updates bilingual feature configuration, settings,
profiles, runtime, updates, installation/setup and Android provenance. It adds
an actual native connection benchmark and tagged device-capture compatibility
probes, removes reader-facing authoring notes and adds blur-based capture privacy
checks. This is not the final documentation delivery.

## Sources and Isolation

- Desktop: `origin/dev` at `be186c524ab9f7a91c41582aec3a5fef06614751`.
- Android: `origin/android-dev` at `5ca0ac7ca88ec8523d17bfbd9aca0750d8ba7d78`.
- Backend code audit: `baas-dev` at
  `d0a86a089068766ff53682b501b90bee99857a71`. The fresh Android first run
  downloads the configured `master` archive; the new friend-filter omission
  was also checked in that actual installed source. Do not infer the archive's
  Git revision from the local audit revision.
- Docs checkout: `../baas-tauri-docs`, branch `docs/dev-refresh`.
- Git cannot create `dev/docs` while `dev` exists. No shared branch was
  renamed/reset; the main checkout remains on its existing fix branch.
- All tracked edits are confined to `docs/`. Native desktop capture uses
  `../.codex_tmp/docs-refresh`. Fresh Android builds use a separate checkout,
  `../baas-docs-android-validation`, branch `docs/android-validation`.
  The existing `android-dev` checkout was not edited.
- Captures show actual native Tauri/WebView UI with isolated demo profiles,
  not frontend fixtures. They do not prove successful game-task execution.

## Requirement Audit

| Requirement                                          | Current evidence                                                                                                                                              | Remaining work                                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| No external landing page                             | SiteHome removed; root/docs enter internal localized docs                                                                                                     | Final deployment checks                                                                                                  |
| Environment language, English fallback, saved choice | Focused locale/link tests; browser entry, denied-storage and manual-persistence cases pass                                                                    | Deployment prefix behavior                                                                                               |
| Chinese/English parity                               | All 17 configuration categories, six settings categories, profile/runtime/update/install/setup workflows and expanded architecture in both languages          | Repair and remaining developer pages                                                                                     |
| Every current desktop UI detail                      | Manual configuration/workspace/installer audit; compiler-AST coverage of 79 draft fields, nine immediate commands, settings labels and shortcut IDs           | Remaining surfaces; conditional capture/interaction and platform execution review                                        |
| Fresh light screenshots                              | 126 desktop + 48 freshly rebuilt Android captures, manifests, two real GIFs; real nonblank remote-preview frames verified                                     | Conditional selectors/dialogs, live game; replace other old references                                                   |
| Necessary GIFs                                       | Actual automatic-save/undo recordings with reader-controlled playback                                                                                         | Assess graph, structured-editor and game motion                                                                          |
| Rounded/shadowed media                               | 8px radius/shadow and layout checks pass in tested theme/viewport combinations                                                                                | Remaining pages and deployment prefix                                                                                    |
| Developer principles                                 | Architecture explains ownership, drafts/ACKs, graphs, framing/batching, recovery and Android process separation                                               | Auth/protocol, updater, recognition/backend and native implementation depth                                              |
| Interactive explanations                             | Working p50/p95 chart controls, GIF playback and localized diagram zoom/reset with a scrollable viewport                                                      | Assess further useful diagrams/components                                                                                |
| Rigorous benchmark charts                            | Encoding/store samples plus 5,400 actual Windows native RPC samples across encrypted WebSocket/Pipe/SHM; raw data, hashes, shared-axis charts and limits      | Full script control/capture comparisons, large payloads, other platforms and critical stages; no small-RPC extrapolation |
| APK installed                                        | Fresh pinned-source ARM64 and x86_64 APKs built/installed, hashes and commands recorded                                                                       | Release/real ARM device coverage is not established                                                                      |
| Android runs beyond installation                     | First-run download/auth/config sync, native Shizuku permission, x86_64 display and native control overlay                                                     | Healthy game frame, input, task completion, takeover/restart and background lifecycle                                    |
| Android operation explained                          | Rewritten first-run, exact regional packages, authorization states, read-only preview, shared run slot, lifecycle and notification limitations                | Finish game validation and reconcile remaining settings/update/error details                                             |
| Docs mobile/light/dark                               | All 35 content routes: 280 render cases across two languages, two themes and two viewport sizes                                                               | Manual semantic/visual review and final deployment                                                                       |
| Search/links/media/build                             | 289 browser cases; 74 exported HTML pages checked; 75-route build                                                                                             | Recheck after future edits and final deployment                                                                          |
| Media/content privacy                                | 14 installer captures use local blur; all 343 raster files/351 frames checked with local OCR; obsolete sensitive assets removed; inventory-bound report/tests | Further manual review for names, QR codes, private hosts and changed media                                               |
| Final review/delivery                                | Verified incremental checkpoint only                                                                                                                          | Finish full scope, final review and PR                                                                                   |

## Configuration Checkpoint

`evidence/configuration-coverage.json` maps every registered category to its
source/editor and bilingual page. The compiler-API test detects changes to
Draft/inline-initial field shapes and verifies mapped field mentions/commands.
It does **not** prove prose accuracy, every conditional UI state, backend
implementation or game execution.

The manual audit covers Cafe, Lessons, both shops, all Crafting stages, Arena,
Total Assault, Final Restriction Release, Drill, daily/event sweeps, friends,
Server, Script, Emulator, exploration/story/events, Teams, Push and Other.

Important source-verified caveats are explicit in both languages:

- Cafe's empty named invitation list falls back to lowest affection.
- Empty Lesson tier selection is not a disable switch.
- Shop UI permits 0-5 refreshes; audited backend caps both shops at three.
- Arena threshold/zero refresh does not guarantee skipping the challenge.
- Event integer `1` differs from `1.0`; AP shares round down and targets
  over 50 trigger the audited backend's all-AP recalculation.
- Friend cleanup ignores the new filters in the audited/default installed
  backend and deletes non-whitelisted friends. It was not executed.
- Final Restriction Release controls do not establish corresponding backend
  implementation. Tauri autostart consumption was not found outside its editor.
- Stage/uncensor Execute commands act immediately; they are not Save buttons.

## Workspace Checkpoint

The bilingual System, Profiles, Home Runtime and Updates guides were rebuilt
against the pinned desktop source and audited backend. The architecture guide
now describes preference/profile ownership, archive commands, log retention and
durable idle-update recovery. Source findings that affect safe operation are
explicit in both languages:

- Same-name ZIP import replaces the existing profile directory without an
  additional frontend overwrite confirmation. ZIP export includes all files in
  that profile directory and may contain private data.
- The advanced remote-preview size labels are swapped relative to their bound
  fields. Saving can apply the old state snapshot; close and reopen the camera
  preview to reconstruct it from newly stored settings.
- Task logs and system diagnostics are separate. Copy/Export uses the filtered
  system-log view; Clear affects all sources after confirmation. Retention and
  truncation limits prevent treating it as a complete filesystem log archive.
- Application shortcut editing and global profile shortcuts have different
  scopes, validation and save behavior. Idle-update recovery restores scheduler
  states, not an interrupted battle frame.

Thirty new native desktop screenshots document actual profile/settings/log
dialogs. The capture verified invalid-name rejection, a locked profile server,
cancelled deletion/log clearing, Escape cancellation and reserved-key rejection.
It did not create/import/export/delete profiles, clear logs, save or exercise
new global hotkeys, run tasks or install updates. The real global recorder may
temporarily suspend and restore existing OS shortcut registrations.

Six further native screenshots show a real desktop preview of MuMu's Android
BAAS interface and the expanded/advanced controls. Pixel probes found decoded
400 x 720 frames with multiple colors in both locales. No game-input, clipboard,
power or new video-setting commands were sent; the preview was closed afterward.
This is not proof of healthy Android game rendering or task completion.

`evidence/workspaces-coverage.json` and the compiler-API tests cover six settings
sections, statically labelled settings/remote inputs, application shortcut IDs
and profile command names. They detect mapped source drift, not semantic
completeness, OS/device effects or every conditional state.

Both diagrams pass exact 150%/800% width-ratio, zoom-out, reset, disabled-state
and internal-scroll checks in the eight locale/theme/viewport combinations.
Initial layout retains each diagram's natural dimensions. Additional light/dark
390px visual checks verified readable 400% diagrams and no document overflow;
the desktop vertical diagram fits without unwanted enlargement. Two separate
visual probes timed out; six isolated direct-load probes and repeated final
captures passed. The cause of those timeouts was not established. That earlier
checkpoint had 177 cases; the current all-route browser evidence has 289.

## Installation and Setup Checkpoint

The install and setup.toml guides were rewritten in both languages against
`SetupPage`, the preflight/config/terminal components, native commands and the
`baas-updater`/`baas-term` configuration and workflow implementations.

- Ordinary and executable-adjacent portable roots have different ownership and
  persistence. A remembered nonempty directory can start preparation without
  proving backend validity. Initial Cancel exits the application.
- Advanced cancellation retains parent draft changes; UI preferences persist
  immediately. Unverified CDK text does not become a verified credential.
- All 14 planned nodes, parallel branches, custom-interpreter dependency skips,
  retained UV cache and structured-log copy limits are documented.
- Reused code/custom Python actually completed with a pending Record Git
  Versions node and a 13/14 display. Backend ready and authenticated sync remain
  separate signals.
- Terminal Escape cancellation was exercised after dismissing the real error
  dialog. Missing-entrypoint failure, node tooltip, read-only portable root,
  transport choices and completed-log retention were captured in both locales.
- Completion reused existing audited backend code and a preinstalled custom
  Python. Fresh network download, managed dependency installation and actual
  Windows/macOS/Linux package installation were not tested in this checkpoint.
- Source inspection found automatic desktop authentication and a recovery path
  that removes four backend credential/trust files before restarting. Recovery
  was not invoked on shared or user data.
- The full schema example is parsed as TOML and compared across languages.
  Compatibility fields without active workflow consumers, lossy typed migration,
  invalid-file backup, source ranking, repository reset behavior and the actual
  requirements-cache fingerprint are explicit.

Fourteen new native release screenshots use a separate disposable portable
root. The executable SHA-256, source revision, locale/scenario checks and blur
provenance are in `public/media/desktop/installer-manifest.json`. All 26 demo
tasks remain disabled. No game input or task execution was started.

## Writing and Privacy Checkpoint

Reader pages no longer repeat the author's branch/capture plan or the user's
language/theme instructions. The rejected contrast formula is checked in source
tests. Installation safety warnings and benchmark measurement boundaries remain
reader-relevant content. Full authoring/verification notes stay in this ledger
and the repository README rather than the published guide body.

Sensitive image fields use local blur. The installer capture temporarily sets
an inline `blur(12px) !important` filter, verifies its computed value and restores
the original style in `finally`. This is necessary because low-effects mode
overrides ordinary filter styles. Matching visible monospace tooltip commands
must be blurred too; targeting only the accessibility tooltip clone missed the
visible text in an earlier attempt. Those captures were replaced before this
checkpoint. The error dialog and completed tooltip were visually checked.

The local OCR pass decoded 343 public raster files and all 351 frames without
failures. Only two generic emulator-path placeholders remained as pattern
findings; both were visually reviewed and allowed by exact image hash. Six
obsolete assets with private paths were removed from `public/`, and the exported
site was checked for their absence. The 343 exported image files matched the
reviewed public originals byte for byte.

`scripts/audit-media-privacy.ps1` uses Windows OCR locally and stores raw results
only in ignored `.cache/`. `scripts/summarize-media-privacy.mjs` checks scan/input
hashes and inventory, then emits `evidence/privacy-review.json` without recognized
text. The tests detect changed media or public JSON/MDX containing private local
workspace paths. A supplementary read-only metadata inspection found no matched
local paths, emails, credential assignments or personal XMP fields; 17 EXIF user
comments contained only the generic Screenshot label. These are heuristic checks,
not proof that all names, QR codes, private hosts or illegible text are absent.

A later visual spot check found a game nickname in the legacy windowed/16:9
image and shared-account/job identifiers in an unreferenced legacy CVAT image.
They are recorded as pending visual findings in the privacy report; the overall
publication privacy review is explicitly incomplete. The OCR patterns did not
detect these names. The user has been asked to choose deterministic local blur
or recapture for old screenshots. Do not interpret zero OCR-pattern findings as
zero remaining visual findings, and do not merge/deploy this checkpoint as a
completed privacy review.

The all-route smoke test exposed literal strong-markup delimiters in two Chinese
paragraphs. Both were fixed and the complete 289-case suite then passed.

## Expanded Benchmark Scope

The requested comparison includes actual connection transports, script control
methods, screenshot methods and other critical performance stages. The current
encoding/log-store chart alone does not satisfy it.

Existing native Linux carrier RTT and actual UI transport evidence was located
and initially inspected. Carrier-only WS excludes product encryption and uses
minimal carrier clients; it must not be conflated with the encrypted product UI
path. Some UI samples have millisecond/zero timer quantization. Historical live
game records contain device/config identifiers and must not be copied into
published raw datasets without sanitization. The actual Windows native RPC
comparison below is now published; capture/control and the other required
performance stages remain incomplete.

Further measurements need controlled environments and output equivalence,
sanitized raw samples, warm/cold boundaries, versions, timer resolution,
p50/p95 and failures. Input acknowledgment is distinct from visible action;
capture comparisons must check freshness, dimensions, content and acquire/
transfer/decode boundaries. Unsupported platform/method combinations need
explicit reasons. OCR/matching, startup/update cache, framing/encryption,
logging and rendering are additional candidates, not completed benchmarks.

## Native RPC Measurement

`scripts/measure-native-transport.mjs` attaches to the isolated release WebView,
imports its already cached entry module and finds the existing production store.
It does not load a second fixture store or change application source. Before
restarting a backend it checks the executable SHA-256, CDP storage-root ownership,
one disabled 26-task demo profile and idle runtime state. The first preflight
mistook the backend's logs directory for a second profile; the guard was fixed
to count actual event-bearing profile directories before any measured run.

The completed run contains all six permutations of WebSocket/Pipe/SHM: 18 mode
blocks, each with 50 warm-ups and 300 sequential measured requests. That is 900
warm-ups plus 5,400 measured read-only status calls, with no observed warm-up or
measured failures. Every callback is the same empty status object (44 bytes of
callback JSON after the store removes the wire envelope/timestamp). WebSocket
uses the actual product SecureWebSocket encryption; both native modes use their
actual Rust/Python and raw WebView bridge path. The network is same-host loopback,
not LAN/WAN. CDP scheduling is outside individual timers.

The Windows x64 release executable/source matches the installer provenance.
Backend is d0a86a0; Python 3.11.9, WebView2/Edge 155, Ryzen 9 9950X, 32 logical
CPUs and 31 GiB. The observed WebView timer quantum is approximately 0.1 ms.
Single-call p50/p95: WebSocket 0.3/0.4 ms, Pipe 0.7/0.9 ms, SHM 0.8/1.0 ms.
The 36 fifty-call block means per mode include callback validation/loop overhead
and are separately labelled. This small empty-response workload is not a carrier
throughput or image/game ranking. No confidence interval or cross-host claim is
made; other host activity was uncontrolled.

Raw samples, ordering, readiness and source/executable/harness hashes are in
`public/benchmarks/native-transport-current.json`. Publication and tests recompute
statistics and reject incomplete restoration, unequal replies, hidden failures,
missing samples and edited summaries. Native startup/switch readiness remains
separate and includes the previous mode's stop, warm-cache restart, authentication
and sync. The original SHM mode was restored and data synchronization completed.
No task was started. The new shared-axis chart, independent p50/p95 controls,
rendered values and proportional bar widths pass the eight locale/theme/viewport
combinations. Desktop dark and mobile light were visually reviewed.

The initial full run is preserved in ignored
`.cache/docs-benchmarks/native-transport-initial.json`. Review found that harness
hashes must be captured at sampling startup, not supplied by the publisher later.
That collection/check was moved to the correct boundary and all 18 blocks were
repeated with unchanged timing-loop logic. The final source-bound repeat is the
published run and is not pooled with the initial record. Both runs observed zero
request failures and the same medians at the chart's 0.1 ms precision. Tests
explicitly reject missing provenance and changed harness hashes.

The source audit additionally found the screenshot interval floor of 0.3 seconds,
Scrcpy's new-decoded-frame wait, adapter color/region conversion, fixed input
waits, default asynchronous non-Nemu `Baas_thread.click`, and Nemu swipe's unused
duration parameter. Both performance guides explain these timing boundaries.

## Device Capture Compatibility Probe

The existing x86_64 APK hash was rechecked on-device. CDP's forwarded PID/cmdline
and the actual foreground package both match the owned docs app. Tauri's default
identifier differs from the Gradle override; the first identity-only preflight
rejected that mismatch before creating a fixture, and the stronger package/PID/
APK checks were added. No user or shared APK was changed.

Two real probe passes injected a temporary frame-tag/color canvas into that
owned WebView. ADB, bundled Scrcpy and Nemu returned the expected tagged 720x1280
three-channel frames with correct color calibration. The observed Nemu output
was BGR despite ambiguous SDK/conversion naming, demonstrating why output checks
are necessary. The stock desktop uiautomator2 wrapper exhausted its image decode
retries and returned None in both passes. These are one-frame compatibility
probes, not steady-state performance data; initialization/first-call times remain
in the ignored local record and were omitted from committed compatibility evidence.

The failure is a verified service mismatch, not an established Android 15 limit:
device port 7912 belongs to Android BAAS's authenticated local bridge. Direct
device TCP GET /version returns `baas-shizuku-display-1`; unauthenticated
/screenshot/0 returns HTTP 403 JSON rather than an image. A child-only NO_PROXY
test and direct ADB socket test returned the same result, ruling out the host
HTTP proxy as its cause. Source confirms the private-token boundary and different
API. No token was read/sent and no authentication was disabled. The bilingual
Android guide now explains port ownership and safe client switching.

`evidence/device-capture-probe.json` preserves the sanitized findings and source/
runtime/package digests. A separate desktop fixture test checks trusted versus
synthetic input, target bounds, token bounds, overlay ownership and underlay
restoration; its eight checks are not Android input latency. Four Python tests
exercise frame validation, channel detection and stale/black/malformed rejection.
The real Android overlay was removed after both probes; Documentation Demo still
shows 0/26 tasks enabled. The probe sent no input and closed its own Scrcpy/Nemu
sessions. The production Scrcpy adapter uses its standard /data/local/tmp jar;
the probe has a preflight guard against an occupied fixed socket. Do not delete another job's agent
or session as cleanup.

`evidence/benchmark-post-state.json` records the actual restored native SHM/auth/
sync/idle state, all 26 desktop demo tasks off and no Android overlay with 0/26
tasks enabled. A subsequent device socket check found no fixed Scrcpy listener.
The temporary desktop store-reference global was removed. Two additional body
search checks for 7912 navigate to the new Android guide section in both locales;
their evidence is separate from the 289-case full page suite.

Next capture/control measurements need an independent target that does not own
the BAAS bridge port. A minimal standalone Android benchmark activity can supply
frame markers and harmless touch feedback while only the owned docs APK is
temporarily stopped; check/restore service ownership and the original app after
testing. Reuse the existing toolchain (AGP 8.11.0 / Gradle 8.14.3) and keep all
target sources under docs/. Do not substitute a token-injected BAAS bridge for
standard desktop uiautomator2. Retain the separate Android-local/Shizuku path and
the unresolved real game/lifecycle requirements.

## Fresh Android Evidence

- ARM64 package: `io.github.kiramei.baas_tauri.docs`; APK 102,086,504 bytes,
  SHA-256 and build/install results in `evidence/android-arm64-validation.json`.
- MuMu advertises x86_64/ARM64 translation. Its x86_64 Shizuku process cannot
  load the ARM64 `libbaas_display_capture.so`: EM_AARCH64 vs EM_X86_64.
  ARM64 installation and Home therefore do **not** prove the game path works.
- The existing x86_64 build path produced a 106,607,198-byte APK without tracked
  app-source changes. Package `io.github.kiramei.baas_tauri.docs.x86`;
  provenance in `evidence/android-x86-provenance.json`.
- Shizuku v13.6.0 was downloaded from its official GitHub release and installed
  separately. The manager's actual native startup command was used, followed by
  the real authorization dialog. Service UID 2000 was reported.
- A new Bilibili `Documentation Demo` profile has all 26 task switches off.
  The existing user `smoke-bilibili` profile was not edited.
- x86_64 created a virtual display and native preview/control overlay. The game
  remained at a startup image and its Unity activity appeared on the main
  display, so real game input/task completion is still **unverified**.
- The native preview is read-only. The audited foreground notification has no
  Start/Stop actions; Shizuku initialization also attempts notification
  suppression. Obsolete bundled-installer/backend and notification-toggle
  claims have been removed from the Android guide.
- The 48 Android screenshots now identify the fresh x86_64 APK. They use actual
  light theme and the actual Appearance resource-display toggle off, avoiding
  overlapping Home resource labels without modifying application code.
- `evidence/android-install-smoke.json` is historical evidence for the older
  preexisting APK, not the provenance for the new screenshots.

## Next Implementation Steps

1. Capture and verify missing conditional configuration states (named/starred
   Cafe, student selectors, Crafting phase 2/3/recommendations, preset grids,
   structured legacy/invalid states and relevant dialogs).
2. Rewrite repair/troubleshooting and remaining platform-specific details against
   current source; extend the audited install/settings/profile/runtime/update pages as
   further native and backend execution evidence becomes available.
3. Expand backend/recognition/auth/updater/native developer principles; review
   existing measured evidence; extend the actual small-RPC experiment to relevant
   payloads/platforms, then measure control/capture and other critical stages with
   sanitized raw samples and controlled boundaries. First isolate the device
   target from the Android BAAS local bridge described above.
4. Finish the Android game display/Unity transition investigation, then verify
   real input, a low-risk supervised task, takeover/restart and service/activity
   cleanup. Do not test friend deletion, paid purchases or uncensoring.
5. Reconcile remaining bilingual content and old images; assess additional
   explanatory interaction and GIFs without claiming untested behavior.
6. Audit every page in desktop/mobile/light/dark, search, links/media and deployed
   base path, then review the docs-only PR. Do not merge this checkpoint as if
   the entire goal were complete.

## Runtime Handles

- Preview: `http://127.0.0.1:4173/`, static server serves `docs/out`.
- The earlier desktop PID 39168 was exited through the real process command;
  CDP 19230 is offline. Installer validation uses
  `../.codex_tmp/docs-installer-20261020`, native PID 41496, CDP 19235.
  Revalidate before reuse. Its backend entrypoint is restored. The native RPC
  experiment entered Home and restored SHM with authentication/data ready;
  all 26 demo tasks remain disabled. The temporary benchmark global only held
  the existing store reference, without modifying production methods.
- Device: `127.0.0.1:16384`.
- Fresh x86_64 WebView PID was 6147, forwarded on 19233. Re-discover after restart.
- Earlier `.dev` and ARM64 `.docs` validation apps were stopped to avoid
  conflicting backend ports. No game scheduler was started during this pass.
- Android/desktop resource-label overlap is an app-source issue, not fixed here.
- Windows Next 16 export still has a segment-prefetch nested/dotted-path mismatch:
  normal navigation passes, but Linux/Pages output requires verification.

## Verification Scope

`bun test tests`: 25 tests / 708 assertions, including field-shape/document,
complete bilingual TOML, privacy inventory, reader prose, native statistics,
ordering/output equivalence and probe-scope checks. Four Python frame-validation
tests and eight desktop fixture checks also pass. These are docs/benchmark
harness checks, not a substitute for application or real game tests.

`bun run build`: 75 routes. Static link scan: 74 index HTML pages, excluding the
separate not-found route. Browser suite: 289 cases (280 render combinations for
all 35 content routes plus entry/search/language checks), including both architecture diagrams and zoom
interactions. Static links, anchors and media have zero reported failures. The
static-link command needs the same optional `PLAYWRIGHT_MODULE` environment
override as browser smoke checks when Playwright is not installed locally.

Every requirement still listed as remaining is unachieved.

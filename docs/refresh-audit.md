# Documentation refresh audit

This ledger preserves the full requested scope. **The refresh is not complete.**
The current checkpoint updates bilingual feature configuration, settings,
profiles, runtime, updates, installation/setup and Android provenance. It adds
actual native status-RPC and larger-config synchronization benchmarks, plus tagged device-capture compatibility
probes, 800 desktop-adapter screenshot measurements and 576 verified input
measurements, plus 400 Android-local screenshots and 216 Android-local inputs.
It adds native Android game media, updater internals and localized
documentation controls, removes reader-facing authoring notes and adds blur-based
capture privacy checks. This is not the final documentation delivery.

## Sources and Isolation

- Desktop: `origin/dev` at `be186c524ab9f7a91c41582aec3a5fef06614751`.
- Android: `origin/android-dev` at `5ca0ac7ca88ec8523d17bfbd9aca0750d8ba7d78`.
- Both remote branch tips were rechecked with `git ls-remote` during this checkpoint.
  The isolated Android repair is now `36f08fd3` (preview checkpoint `128983b8`).
- Backend code audit: `baas-dev` at
  `d0a86a089068766ff53682b501b90bee99857a71`. The fresh Android first run
  downloads the configured `master` archive; the new friend-filter omission
  was also checked in that actual installed source. Do not infer the archive's
  Git revision from the local audit revision.
- Docs checkout: `../baas-tauri-docs`, branch `docs/dev-refresh`.
- Git cannot create `dev/docs` while `dev` exists. No shared branch was
  renamed/reset; the main checkout remains on its existing fix branch.
- Docs-checkout edits are confined to `docs/` and its read-only validation workflow
  `.github/workflows/docs-validation.yml`. Native desktop capture uses
  `../.codex_tmp/docs-refresh`. Fresh Android builds use a separate checkout,
  `../baas-docs-android-validation`. Baseline captures used `docs/android-validation`;
  the isolated native repair now uses `fix/android-trusted-display-and-insets`.
  The existing `android-dev` checkout was not edited.
- Captures show actual native Tauri/WebView UI with isolated demo profiles,
  not frontend fixtures. They do not prove successful game-task execution.

## Requirement Audit

| Requirement                                          | Current evidence                                                                                                                                              | Remaining work                                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| No external landing page                             | SiteHome removed; root/docs enter internal localized docs                                                                                                     | Final deployment checks                                                                                                  |
| Environment language, English fallback, saved choice | Focused tests and browser entry/storage/persistence cases; root/prefix checks on Windows and Linux preserve language, query and hash                          | Final live deployment                                                                                                    |
| Chinese/English parity                               | All 17 configuration categories, six settings categories, profile/runtime/update/install/setup workflows, architecture, backend and updater guides; localized search/TOC/theme/sidebar/image controls | Remaining reader review and developer coverage                                                                       |
| Every current desktop UI detail                      | Manual configuration/workspace/installer audit; compiler-AST coverage of 79 draft fields, nine immediate commands, settings labels and shortcut IDs           | Remaining surfaces; conditional capture/interaction and platform execution review                                        |
| Fresh light screenshots                              | 172 desktop and 96 Android PNG captures, manifests, six real GIFs; native game preview and controls now illustrated                                           | Remaining surfaces and old references                                                                                   |
| Necessary GIFs                                       | Native automatic-save/undo media and two continuous game-preview recordings with reader-controlled playback                                                  | Assess graph and structured-editor motion                                                                               |
| Rounded/shadowed media                               | 8px radius/shadow checks across all content routes, root/prefix exports, Windows and Linux                                                                    | Final live deployment and remaining manual review                                                                         |
| Developer principles                                 | Architecture, backend lifecycle/recognition, Service auth/resume/conflict/framing, CLI and updater ownership/activation/overlay/cancellation/integrity; production replays and 20 real-crypto cases | Remaining backend/native depth, TLS/deployment and device integration                                                   |
| Interactive explanations                             | Working benchmark controls, GIF playback, localized diagram zoom/reset and an evidence-driven recognition trace stepper                                      | Assess further useful diagrams/components                                                                                |
| Rigorous benchmark charts                            | 5,400 native RPC and 5,400 large-config sync samples; desktop adapters: 800 screenshots / 576 inputs; Android-local: 400 screenshots / 216 inputs; raw data, hashes, shared axes, quality/gesture checks | PC-window paths, binary-image transport, other devices, real-game effects and other critical stages                |
| APK installed                                        | Fresh pinned-source ARM64 and x86_64 APKs built/installed, hashes and commands recorded                                                                       | Release/real ARM device coverage is not established                                                                      |
| Android runs beyond installation                     | Current ADB-mode repair passed 112 seconds of title preview, distinct-buffer counts and a 450-frame physical recording; earlier cold-start stall/system crash and SDK display escapes remain unresolved | Resolve startup/placement instability, then verify business tasks, unattended foreground-app switching, other devices and final integration |
| Android operation explained                          | Rewritten first-run, exact regional packages, authorization states, read-only preview, shared run slot, lifecycle and notification limitations                | Finish game validation and reconcile remaining settings/update/error details                                             |
| Docs mobile/light/dark                               | All 36 content routes: 288 render cases across two languages, two themes and two viewport sizes                                                               | Manual semantic/visual review and final deployment                                                                       |
| Search/links/media/build                             | General/search checks plus 1,336 strict export cases across four OS/prefix variants; 76 exported HTML pages; 77-route build                                    | Recheck after future edits and final live deployment                                                                     |
| Media/content privacy                                | 14 blurred installer captures, two legacy blur repairs and six blurred native game assets; 442 raster files/576 frames checked with local OCR               | Further manual review for names, QR codes, private hosts and changed media                                               |
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
checkpoint had 177 cases; the current all-route browser evidence has 417.

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
Both images now use local Gaussian blur baked into the PNG pixels: one nickname
region (sigma 16) and six account/job regions (sigma 20). The files retain their
original dimensions. `scripts/blur-private-media.mjs` refuses unknown source
hashes, skips matching processed files and checks that every region changed
while every decoded RGBA pixel outside those regions is unchanged.
`evidence/legacy-media-blur.json` binds the source/output hashes, rectangle plan,
pixel checks and native-size visual review. No generated UI or opaque masking
was introduced. The known visual findings are resolved only by matching reviewed
redaction evidence; an arbitrary image hash change cannot clear them.

The repeated local OCR pass again decoded all 343 files/351 frames without
failure. The two known legacy findings are resolved. The overall publication
privacy review remains incomplete: OCR missed these names previously, and the
remaining media still needs manual review. Do not interpret zero OCR-pattern
findings as proof of complete anonymization or merge/deploy this checkpoint as
a completed privacy review.

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
comparison and the four-adapter device comparison below are now published.
Other platforms, larger payloads and the remaining critical performance stages
are still incomplete.

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

The following device measurement checkpoint uses an independent target that
does not own the BAAS bridge port. Its standalone Android activity supplies
frame markers and harmless touch feedback while the owned docs APK is
temporarily stopped; service ownership and the original app are checked afterward.
It reuses the existing toolchain (AGP 8.11.0 / Gradle 8.14.3), with all target
sources under docs/. It does not substitute a token-injected BAAS bridge for
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
   payloads/platforms, then extend the completed four-adapter device comparison to
   PC-window/Android-local paths and other critical stages with sanitized raw
   samples and controlled boundaries. Keep the independent device target separate
   from the Android BAAS local bridge described above.
4. Finish the Android game display/Unity transition investigation, then verify
   real input, a low-risk supervised task, takeover/restart and service/activity
   cleanup. Do not test friend deletion, paid purchases or uncensoring.
5. Reconcile remaining bilingual content and old images; assess additional
   explanatory interaction and GIFs without claiming untested behavior.
6. Audit every page in desktop/mobile/light/dark, search, links/media and deployed
   base path, then review the docs-only PR. Do not merge this checkpoint as if
   the entire goal were complete.

## Native Device Measurement Checkpoint

The final run on 2026-10-20 (07:33:34–07:43:00 UTC) completed 32 capture blocks
and 48 input blocks: 800/576 measured samples and 160/144 warm-ups. Every measured
and warm-up input/frame validation passed. `public/benchmarks/device-current.json`
retains every sample, block order, counter, MSE value, received press duration,
travel, environment, source/APK hash and observer decode sample. The client
imports only the 21 KiB hash-bound summary, not the approximately 798 KiB raw record.

The independent Java/Canvas target has no account, network, backend or scheduler.
It renders a frame barcode continuously at 1280x720. The two scenes differ in
background motion; the fixed quality pane is identical. It validates completed
input count, event duration and endpoint travel, with a 10 px travel tolerance;
it does not validate intermediate trajectory or game success. The captured
target image is a separate untimed ADB PNG, reviewed as test counters/texture
only, with APK/PNG provenance in `evidence/device-target-capture.json`.

Capture p50 in the static scene was approximately ADB 70.5 ms, uiautomator2
77.1 ms, Scrcpy 21.8 ms and Nemu 4.0 ms. Nemu repeated 57/100 static and 60/100
animated frame counters at this unthrottled sampling cadence; those values are
not its polling behavior under the script's 0.3 s interval. Scrcpy's fixed-pane
mean MSE was approximately 7.88/21.39; the other three paths were pixel-identical
to the ADB regional reference. These are scoped measurements, not a game FPS
ranking or whole-frame/freshness equivalence proof.

The common Scrcpy observer distinguishes synchronous API return from expected
visible input-counter change. Its 14,658 barcode decodes had p50 0.78 ms,
p95 1.28 ms; that detection work is included in the visible endpoint. Requested
300 ms uiautomator2 swipes/long presses reached approximately 1,995 ms received
duration on this host; the cause is unisolated. Nemu's swipe duration was about
254 ms and travel 390–399 px for the 300 ms/400 px request. Both languages state
these non-equivalent gesture semantics explicitly. No outlier is removed.

Provisioning failures and harness debugging preceded the final run. The staged
Linux amd64 agent requires an absent glibc loader; production selects the 386
0.10.0 binary on x86_64. That binary plus the existing 2.3.3 instrumentation
server produces valid frames/input. A screenshot without the instrumentation
service failed in a separate setup probe; it is not silently substituted with
the authenticated Android BAAS bridge. No shared APK was replaced. Automatic
library repair/reinstallation is guarded off; failures would remain failures.

Cleanup verifies the unique agent process/executable, stops owned connections,
restores shared temporary files and removes only this run's port forwards. The
instrumentation process is stopped under its own app UID, preserving both
installed APK hashes. The x86 BAAS demo returns authenticated/ready with no
running tasks or autostart profiles. Current authoritative state has two
profiles: the documentation profile has 0/26 enabled tasks; the other existing
profile retains 22/26, without being edited or started. The inactive owned ARM
validation clone stays stopped to avoid shared backend-port conflicts.

The publisher verifies all 14 adapter/helper/jar files against the pinned backend
Git objects, normalizing CRLF only for Python text, and checks the source hashes
captured before sampling. Editing `measure-device.py` or its demo inspector now
requires a new run. Native target Java/manifest hashes are frozen too. Raw agent
logs, device serials, host paths and native SDK instance identifiers remain in
ignored cache; the public data is an explicit whitelist projection.

The repeated privacy scan decoded all 344 raster files/352 frames without
failure. The two reviewed legacy blur repairs remain valid. Full manual media
privacy review is still incomplete. This checkpoint does not establish Android
real-game input/task completion, PC capture, large-payload transports or the
remaining conditional UI/developer coverage.

`evidence/device-chart-validation.json` adds 16 focused chart screenshots/layout
checks (two charts × both languages × both themes × desktop/mobile), including
the longest gesture label and largest p95 visible-response values. The full
417-case suite separately checks all 128 scenario/endpoint/quantile combinations.

`public/benchmarks/device-environment-audit.json` binds a post-run CPU/memory/
Windows inventory and native SDK digest to the raw record. The SDK has no PE
version fields; its digest is collected after sampling and is labelled that way.
The library timestamp predates the run, but timestamps alone do not prove binary
immutability. No host path, machine identifier or account data is published.

## Conditional Configuration Checkpoint

The real desktop and Android builds now have 90 additional native PNGs and two
desktop priority-reorder GIFs across English and Chinese. The complete platform
manifests are `public/media/{desktop,android}/conditional-manifest.json`.
They bind source revisions, executable/APK and capture-script hashes, per-asset
hashes, 22 verified behavior checks per platform, and successful restoration of
all 27 listed demo fields. Other profiles and demo event data compare unchanged.

Covered states: Cafe named/starred invitation, five favorite positions, second
Cafe conditional tab and undo/redo; student filtering, empty results and filter
retention; crafting stage counts, all phase-2/3 material rules, one-shot student
recommendation replacement, searchable node picker, keyboard reorder preview/
cancel/commit/undo and invalid count; formation preset/order visibility; Lesson
student-list visibility and retained order; sweep student-stage append/dedup,
empty-count local validation, unknown plan/count preservation, explicit reset/
delete with undo; exploration's retained out-of-range and unknown old rows.

Six bilingual feature guides and the Android guide use these images. The
controlled MotionDemo priority variant starts with a still image and can return
to it. Invalid example plans are explicitly marked as unsuitable for execution.
No scheduler, game input, purchase or friend-deletion task was started.

`evidence/conditional-layout-validation.json` records 56 passing page/locale/
theme/viewport cases and eight stable-size GIF play/stop checks, with zero page
errors. These checks are separate from the full 417-case browser suite. Both
platform manifests are hash-bound to this layout result. Native demo state was
rechecked afterward: authenticated/ready, zero running sessions or autostart,
documentation tasks still 0/26, and the other Android profile remains 22/26.

The capture harness initially hit selector visibility and retained-draft issues;
incomplete attempts were not accepted as evidence. Both final runs completed
and restored their state. Each locale starts with fresh native WebView history.
Android reloads still emitted transient stale Tauri callback errors; successful
reconnection does not establish that this application issue is fixed.

The repeated full-public scan decodes 436 raster files / 452 frames with zero
decoding failures, unresolved pattern findings or pending known visual findings.
The two legacy local Gaussian-blur repairs still pass region/pixel checks.
Full manual publication privacy review remains incomplete. This pass does not
establish real-game execution, Android lifecycle reliability, PC capture or
large-payload transport performance. Other conditional/developer coverage still
requires systematic reconciliation against source.

## Backend Principles Checkpoint

The backend-development pages replace the legacy Conda/Python-3.9.21 setup and
three-node overview with the service entry point, dependencies, initialization
gates, startup/task injections, session/worker ownership, scheduler ordering,
retry/stop limits, recognition branch precedence, coordinates, capture throttle,
OCR, migration and logger contracts. Source links target the audited backend
commit. They distinguish command acceptance from completion and record known
limitations: missing-OCR override, cooperative-stop timeout, `None` return
ambiguity, non-recursive migration and live-object versus saved-config state.

`public/developer/recognition-replay.json` comes from the actual `co_detect` and
`match_img_feature` ASTs with deterministic adapters, not a hand-written second
recognition implementation. Twelve cases cover end/reaction precedence, image
fallback, repeated-action suppression, popup handoff, tentative threshold,
timeout, stopped state, tuple return, negative coordinates, wrong package and
cached first frame. No screenshot engine, device input or real timing is used.
Both guides explicitly state these limits. The publisher verifies 37 source
files against Git; its own SHA is bound to the output.

An independent Git archive was tested, without changing shared source or live
configuration. The service suite, task-retry test and OCR tests collected 416
cases: 415 passed and one Unix-socket case was skipped on Windows. The safe
report `evidence/backend-development-validation.json` binds JUnit/replay hashes,
source/test snapshot hashes and post-run package metadata. There was no fresh
dependency installation, live-device execution or Linux validation. The CLI
help was checked only in the disposable snapshot. Five deprecation warnings
remain in the cache log; this docs pass does not repair them.

The final recognition UI check passes 96 scenario/locale/theme/viewport cases
and 864 individual step assertions. Arrow buttons, slider keyboard endpoints,
disabled states, reset, trace-row scrolling, nonempty code labels and document
overflow are checked. Sixteen cached screenshots cover tuple results and
suppressed actions. The report binds the data, component, CSS and reader-source
hashes. One earlier concurrent-browser diagram wait timed out; the isolated
final run passed, without establishing that timeout's cause.

The current six-case search probe checks both existing Android port references
and newly indexed backend content. `co_detect` finds the backend guide in both
languages; Chinese migration and English cooperative-stop queries navigate to
the same localized guide. Results remain in `evidence/new-content-search.json`.

The replay publisher writes UTF-8 bytes with LF explicitly. Windows text-mode
newlines initially changed at Git normalization and invalidated raw hashes;
the publisher, regenerated replay/validation data and presentation evidence
were corrected together. Tests reject CR bytes in these generated JSON files.

## Service and CLI Contract Checkpoint

The bilingual Service pages now explain control identity/password/remember
flows, per-channel resume/SecretStream, credential persistence/expiry, Origin
versus CORS, HTTP loopback trust, sync acknowledgment/conflict, Trigger binary/
progress ordering, remote plaintext-output boundaries and local IPC framing.
CLI pages remove the obsolete generic dependency setup and incorrect PDM
invocation, cover all eight current options/environment defaults and explain
that importing the legacy example immediately runs resource-consuming tasks.
Help still initializes diagnostics and performs PID cleanup; it is not free of
filesystem effects and is exercised only in a disposable working directory.

The source audit identifies two deployment/security limitations without changing
application code: the default signing seed is a shared public constant, and
password revocation does not make the server close every existing business
stream. The real client store closes its connections on the control notice,
but an uncooperative peer need not do so. The pages do not claim a full security
audit or safe public deployment from application-layer encryption alone.

`evidence/service-protocol-validation.json` records 20 actual browser/Python
interoperability cases: production X25519/Ed25519, full Argon2id parameters,
HKDF/ChaCha/SecretStream, password/remember/logout, sparse configuration patch
ack/push/conflict, epoch revocation and the still-open-stream limitation. The
fixture uses actual auth, HTTP, Provider/Sync and ConfigManager code, with
deterministic status/log queues and no ServiceContext/device/game startup.
It verifies 69 backend and four client source hashes against pinned Git content,
binds harness/bundle hashes, and proves that run's browser/server closed and its
private auth/config directory was removed. It is not a timing benchmark.

The first Bun-driven browser attempt stalled before password initialization;
its owned processes were stopped and its exploratory cache was not published.
An initial Node fixture omitted ConfigManager loop setup; that failed attempt
closed cleanly. The corrected Node/Playwright run passed all 20 cases. Earlier
exploratory cache files may remain ignored, and are not covered by the final
run's temporary-directory cleanup claim.

The focused existing backend contract suite collected 44 tests: 43 passed and
one Unix-socket test skipped on Windows. Three deprecation warnings remain in
the private test output. `evidence/service-contract-tests.json` binds JUnit and
seven test-source hashes and keeps deterministic unit-test adapters distinct
from the real browser crypto run. Actual CLI help and mutually-exclusive IPC
option rejection returned 0 and 2 respectively, without starting a server or
legacy game tasks; three CLI source files are verified separately.

`evidence/service-layout-validation.json` has 16 page/locale/theme/viewport cases,
16 diagram zoom/reset checks and four localized search navigations. The cached
Chinese mobile/English desktop diagrams were reviewed. No public raster asset
was added or changed. Ten existing frontend KDF/protocol/factory/recovery-delay
unit tests also pass. The rebuilt site passes all 417 full browser cases and
the 74-page static-link scan. Updater details, broader source/UI reconciliation, real
Android game operation, larger/other benchmarks, manual privacy and final
Linux/Pages deployment remain incomplete.

## Android Game Placement Checkpoint

Two owned Home background-game cold launches reproduced the Bilibili Unity
Activity leaving its intended virtual display for display 0. The second run
is hash-bound to `scripts/probe-android-game.mjs`; the first was exploratory.
`evidence/android-game-validation.json` records the failed placement, two
corresponding Android denial lines, an untrusted virtual display and a
1280x720 completely black captured frame. Seven Android source files were
verified against the pinned Git revision. Shell package output does not list
`ADD_TRUSTED_DISPLAY`; no permission was granted or Shizuku mode changed.

The shell display path omits the trusted flag while the separate root/system
path includes it. Android 15 source supports the placement-permission diagnosis,
but no repaired APK has been built or tested. No source change was made in the
shared or isolated Android checkout at that checkpoint. The subsequent isolated
repair is recorded below; these baseline failure measurements remain unchanged.

Both runs kept every scheduler idle and all documentation tasks disabled. No
game input, login, purchases or game-data clearing occurred. The owned virtual
display is closed, the game started by this probe is stopped, all profiles and
events match their backups, and the frontend Home play state is restored. Close
was dispatched through the production overlay event handler by the probe; it
does not validate a physical native close-button tap. Raw screenshots, private
profile backups and full system logs stay in ignored cache. Zero public media
files were added.

The Android guides now describe the observed combination and read-only
diagnostic commands. Both troubleshooting pages remove stale Accessibility and
notification task-toggle instructions. Real game input/tasks, native takeover/
restart and long-running lifecycle reliability remain unverified.

The rebuilt export passes all 417 browser cases and 74-page static link checks.
Eight additional source-bound checks follow the localized troubleshooting links
to the new diagnostic heading across both languages, themes and viewport sizes;
the cached mobile/desktop views were reviewed. No public raster asset changed.
The legacy local Gaussian-blur verifier remains idempotent (two files, zero
new changes), and its outside-region pixel tests still pass.

## Android Native Repair Checkpoint

The isolated branch contains `20e01805` (native WebView system-bar insets),
`361c7006` (trusted-display preference, shell fallback, game-task recovery and
per-display rotation lock), and `35ec1d21` (continuous preview, focus recovery
and frame-health reporting). Shared desktop/Android branches remain unchanged.
This preview checkpoint's x86_64 validation APK is
`2ebd266c149b16844aa0a93f20ebbebb211e782eec5d011f33f612af6166afed`.
The earlier `6b2705bc` checkpoint remains in private cache.

On API 35 / WebView 110, light/dark views, profile editing and resume retain
native WebView bounds `[0,36,720,1280]`. Twenty-four native JVM tests and the
device-executed C++ frame-content test pass. All 229 frontend tests, TypeScript
checking and the seven-locale check pass. The
MuMu input-method window has zero height, so real onscreen-keyboard resize is
unverified. The capture overlay remains aligned below the status bar.

MAA-Meow at `aa9193f9a11eb1f1cfa71ed5fb917487cb94f3de` was inspected for
virtual-display flag fallback, rotation and task drift handling. Actual shell
UID 2000 creates the fallback display when `ADD_TRUSTED_DISPLAY` is denied.
The game task is recovered onto that display. On the untrusted API 35 path,
focus recovery targets a temporary BAAS-owned window by UID, removes it, then
focuses the existing game task. Its input cannot target the game UID. Supported
trusted displays request independent focus. Stable preview surfaces are not
rebound on every poll, and reconnection can replay the latest acquired image.
Black or non-advancing frames no longer receive a Live status.

The final APK cold-starts into the animated title without diagnostic game taps.
After profile menus, editing, page changes and Home/resume, a three-minute
independent sample records about 30 captured and presented frames per second.
All 12 physical-screen preview crops differ, with at least 70% of RGB channels
changing between consecutive samples. Physical native restart and takeover
buttons pass: restart creates a new display/process, while takeover preserves
the game process, moves its task to display 0 and closes the owned display.
The post-restart 30-second sample also measures about 30 FPS.

Profiles/events are restored and the test game is stopped. Shizuku remains in
ADB mode, without Root. No public media changes. Full automation-task completion,
unattended operation alongside other foreground apps, other devices and Root
mode remain unverified. Private frames, logs, source hashes and the detailed
continuous-preview checkpoint stay in ignored cache.

## Android Runtime Execution Checkpoint

The independent repair branch now includes `d164fb3b` (actual application on
the owned display), `c708a03a` (OCR process ABI), `87441d39` (tap duration),
`05901fb2` (no physical-display package fallback), and `3929434e` (explicit
finger type and released pressure). Shared development checkouts are untouched.

The runtime-validation APK at `3929434e` has SHA-256
`908baec598364843aff22143171e0cd16e3d4b6b0c9ef6964f8d1517387278a1`.
Two separately launched `solve/restart` workers use the installed Python
runtime, authenticated local bridge, Shizuku ADB UID 2000, native screenshots,
image recognition and game input. Each starts with the owned game stopped on
an already allocated virtual display. They return naturally in 34.927 and
37.655 seconds after logging a matched `main_page` feature; neither run needs
manual game input or a stop command. All 26 business-event switches stay off.
These are startup/navigation checks, not business-task completion or a timing
benchmark. A detector return also does not prove every modal has been dismissed.

After profile menus, edit cancellation, Scheduler/Home and physical Home/resume,
the same game process/display remain active. A 29.713-second independent sample
records 891 captured and 891 presented frames, about 29.987 FPS, and 15 distinct
sampled game images. Twelve physical-screen preview crops are all different;
the smallest consecutive RGB-channel change ratio is 67.30%. This checks the
rendered preview as well as counters. Thirteen changed source files match Git
content; the private runtime checkpoint binds their hashes, both worker records,
frame samples, pixels, tests and restoration.

Earlier failures remain separate: OCR first selected ARM64 libraries in the
x86_64 app because the emulator reports an ARM kernel; a corrected process-ABI
selection passes actual English/Chinese OCR self-tests. Two earlier navigation
attempts time out at the title, and a separate 300ms held-input diagnostic enters
the game. One intermediate 50ms run succeeds but its repeat times out. Neither
that isolated success nor the assisted diagnostic is used as the final two-run
proof. The final single-finger event metadata repair precedes both accepted runs.

`e3ed51d7` retains the existing Shizuku service identity and raises its protocol
version to 37, so upgrading can replace the old service. Its installed APK is
`c345b0368a402947622faa109276b79653c4eeeb84b8c8555042f914b6597511`.
This commit changes only service-version selection/comments; the two navigation
measurements above remain tied to their original APK, not relabelled as new runs.
The owned user-service process is automatically replaced after APK installation
and rebinding; the shared Shizuku server remains running. No manual server restart or Root is
used. The identity/version behavior follows the
[Shizuku service manager](https://github.com/RikkaApps/Shizuku-API/blob/master/server-shared/src/main/java/rikka/shizuku/server/UserServiceManager.java).
After the same lifecycle checks, this upgrade APK records 889 captured and
presented frames in 29.645 seconds, about 29.988 FPS, with 15 distinct sampled
images. Its 12 physical preview crops are all different, with at least 68.54%
of RGB channels changing between consecutive crops. A separate private upgrade
checkpoint binds this APK/source and restoration to the preceding runtime proof;
every other implementation file is hash-identical.

Twenty-seven native JVM tests pass. The Android Python suite has 36 passes and
one explicit skip for an externally supplied update-dialog image fixture; the
device C++ frame-content test also passes. All 48 documentation tests still pass
with 8,488 assertions. Reader pages and public media are unchanged in this pass;
the earlier build/browser evidence has not been presented as a fresh run.

The owned demo's connection fields and initialization-normalized defaults are
restored against its original backup; other profiles and every event array match
their backups. Raw game images, account identifiers, complete logs and bridge
tokens remain outside published assets. Business automation, unattended operation
beside other foreground apps, other devices, Root and onscreen-keyboard resize
remain unverified. The full documentation refresh is still incomplete.

## Android Cold-Start and Numbered-Frame Checkpoint

The independent repair now includes `8e38508f`, which waits for WindowManager
to register the owned display, verifies the display-scoped rotation lock and
prevents splash-screen fixed-rotation transforms. Failed setup releases the
display/capture; there is no fallback to changing the physical display. The
Shizuku service identity is unchanged and its version is raised to 38.
Thirty-one native JVM tests pass, including four new rotation-policy cases.
The installed x86_64 APK SHA-256 is
`f225eea908752bdb3471ba7b4bc744e721b540ed4c6c7fe8ceb0f11ac4f31672`.

Three game cold starts create distinct displays. The first two steady samples
record about 30 captured/presented frames per second for 30 seconds; the third
records 29.999 for 119.836 seconds with 55 distinct two-second image samples.
Visual review confirms full-width, correctly oriented game content. These
counters do not measure game-content FPS.

A separate synthetic numbered target is launched after the owned game is
stopped. Every one of 359 physical-screen video frames decodes a changing source
frame ID, with the expected target token and zero inputs. Over 11.960 seconds,
the source-frame-change rate is 29.933/s, maximum gap 67.1ms and p95 gap 33.8ms.
This checks preview presentation on the emulator's 30Hz physical display, not
game throughput or a comparison of capture/control methods. An earlier
pixel-change-threshold heuristic is explicitly discarded because gradual
animation can be counted as static. Raw footage and the hash-bound checkpoint
remain private. All demo configurations/events are restored, the fixture and
game are stopped, and the shared Shizuku server remains unchanged in ADB mode.

## Native Game Media and Updater Documentation

Four light PNGs and two four-second GIFs now illustrate the Android game preview
and native controls in both app languages. They were physically recorded using
the earlier `e3ed51d7` / `c345b036...` APK; they have not been relabelled as the
later rotation-fix build. The GIFs contain 60 frames at 15 FPS. Local Pillow
Gaussian blur is applied before GIF scaling/palette encoding. PNGs preserve
every decoded pixel outside the account-identifier region. The six assets and
all 124 frames are hash-matched to the local OCR review. The complete public
inventory has 442 raster files / 576 decoded frames and zero unresolved pattern
findings. The report still leaves full publication review incomplete.

The publisher resolves the recording's immutable Git commit rather than
requiring that historical commit to stay checked out. Its manifest is written
with LF bytes to preserve hashes after Git normalization. Re-publication retains
an existing visual review only when every asset hash is identical; all six
current assets meet that condition.

`AndroidGameDemo` starts on a static poster and loads motion only on request.
Eight locale/theme/viewport cases verify actual changing browser pixels,
play/stop, fixed dimensions, rounded corners/shadows, image zoom and localized
close/Escape behavior. Troubleshooting anchors and two search queries navigate
to the Android guide. Instructions now distinguish scheduler stop from closing,
takeover and restart, explain frame states and OCR ABI selection, and include
the follow-up cold-start direction repair. The declared API 24 installation
minimum is distinguished from native capture's API 26 requirement.

The bilingual updater reference adds an interactive workflow diagram and covers
source ranking, SHA-setting projection, detached process ownership, manual/idle
stop ordering, delayed Android activation, APK-matched service overlays,
replacement, cancellation, integrity and recovery. Seventeen implementation
files match their pinned Git content; all 56 cited source links have valid line
ranges. This is source inspection. No updater was executed against the shared
checkouts or emulator to validate these descriptions.

Android's manual repository update skips its common `stopAllTasks` path. Its
post-sync command ensures the service exists but does not restart Python.
Even a process restart can use APK-matched `backend-service-overlay` files ahead
of external service files. The reader guide therefore describes stopping all
tasks, closing the display and force-stopping/reopening the app after successful
sync, while checking module origins and client version as well as repository SHA.

Documentation framework labels now follow the route language, including search,
empty results, TOC, anchor/code copy, sidebar and theme controls. Image-preview
close controls are localized too. Framework and search path parsing share the
same English fallback. Eight updater browser cases cover both languages,
themes and viewports, search navigation, empty results, diagram zoom/reset,
theme changes and client-side language switching. The existing recognition
replay passes 96 scenarios and 864 step checks; Service/CLI checks pass 20 cases.

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
- The x86_64 WebView is forwarded on 19233; its PID changed during controlled
  restart and must be re-discovered before use. The last idle/auth/data check
  passed after benchmark cleanup and the separate target screenshot.
- Earlier `.dev` and ARM64 `.docs` validation apps were stopped to avoid
  conflicting backend ports. No game scheduler was started during this pass.
- Android/desktop resource-label overlap is an app-source issue, not fixed here.
- Windows Next 16's segment-prefetch nested/dotted-path mismatch is corrected by
  manifest-bound output normalization. Strict root/prefix checks pass on Windows
  and Linux; live Pages deployment is not claimed.

## Verification Scope

`bun test docs/tests`: 95 tests / 9,360 assertions, including public-asset links, export-path normalization and strict-host checks, search-cache failure recovery, source-bound browser recovery, Service/CLI provenance, crypto boundary and diagram/search checks,
Android game-placement failure/cleanup contracts,
backend-source/replay contracts and native conditional capture/source/restore,
field-shape/document,
complete bilingual TOML, privacy inventory, reader prose, native statistics,
ordering/output equivalence, device measurement/source/restore checks and
probe-scope checks, native media and updater/source/UI contracts. Twelve Python frame/HTTP/ownership/observer/blur tests and eight
earlier desktop fixture checks also pass. These are docs/benchmark
harness checks, not a substitute for application or real game tests.

`bun run build`: 77 routes. Static link scan: 76 index HTML pages. Browser suite:
425 cases (288 render combinations for all 36 content routes, nine entry/search/language checks and 128 device-chart
scenario/endpoint/quantile checks), including both architecture diagrams and zoom
interactions. Static links, anchors and media have zero reported failures. The
static-link command needs the same optional `PLAYWRIGHT_MODULE` environment
override as browser smoke checks when Playwright is not installed locally.

Every requirement still listed as remaining is unachieved.

## Search Failure Recovery

The previous index loader retained rejected promises. A focused reproduction
passed the shared-successful-cache case and failed all five retry/isolation
cases. The old exported browser build also failed to show an error after an
injected HTTP 503 response. The loader now evicts failed downloads/imports,
retains successful and in-flight downloads, and the dialog exposes localized
failure and retry controls. Retry supports the same query through its icon or
Enter, as well as an edited query. It does not silently turn a download error
into empty search results.

The recovery browser suite covers HTTP 503, a network abort and invalid JSON in
both languages, themes and viewport sizes. It verifies closing/reopening the
dialog, the three retry paths, a fresh download after failure, reuse after
success, empty results and navigation to the correct localized page. Captured
error states wait for dialog animations and check viewport bounds. Source and
exported-index digests are retained in `evidence/search-recovery.json`.

## Android Preview Failure Reopened

A new cold start of the isolated `8e38508f` / `f225eea9...` APK on 2026-10-20
stalled on the game's opening image. Android's `system_server` then crashed
with SIGSEGV in `TaskUtils.shouldIgnoreDesktopHomeOcclusion`; the game reported
`DeadSystemException`. The exact trigger is unknown. This contradicts any
claim that the earlier short checks prove stable game rendering. The bilingual
guide now records the unresolved failure and the distinction from historical
successful checks.

Android recovered automatically; no emulator restart or Root change was issued.
Shizuku is disconnected. Restarting its shared ADB service awaits the user's
answer, so further device benchmarks and game validation have not been run.
The current profile/event state matches the immediate pre-test baseline exactly;
the game and fixture are stopped and no game display remains. Raw captures,
crash logs and the restoration record are private in
`.cache/android-native-fix/preview-stall-*`. The shared checkouts remain untouched.
The unfinished Android-local measurement harness is still uncommitted and has
not been used to publish performance claims.

## Static Deployment Checkpoint

The first strict `/baas-tauri` export check reported 1,957 failures: unprefixed
icons/fonts/cursors, failed icon decoding, double-prefixed MDX links and missing
segment-prefetch files. Counts include repeated observations across routes and
display combinations, not 1,957 distinct broken resources. The fixes prefix
metadata/navigation icons, bundle relative CSS font/cursor dependencies and
leave MDX navigation prefixes to Next Link while retaining explicit media paths.

Next 16.2.9's exporter derives a segment path from platform-native `path.relative`
then passes it to a filename function that replaces only forward slashes. On
Windows this emits nested filenames while the browser requests dotted names.
The new build step reads the prerender/segment manifests, uses Next's own
filename encoder and adds only missing canonical files from their exact source
payloads. It compares existing files byte-for-byte and rejects unsafe paths,
missing source files and payload conflicts before adding output. It does not
rewrite Next or change RSC payload contents. The first root pass checked 74
routes / 587 segments and added 217 missing files; focused tests cover
idempotence, existing correct output and rejection paths.

`check-deployment.mjs` uses a strict temporary loopback server with no SPA
fallback or filename aliases. Its 334 cases cover all 36 content routes in both
languages/themes/viewports, real font loading, image decoding/framing, GIF pixel
changes, zoom, retained client-side navigation, search, language switching and
entry language/query/hash behavior and byte-identical raw-record navigation.
Origin-only preconnect hints are excluded
from path validation. The first post-asset-fix check still failed on segment
prefetch paths; this failure is retained rather than treated as a pass.

`Validate Documentation Export` is a separate read-only workflow for docs
branches/PRs. Its two Linux jobs build root and `/baas-tauri` exports and run the
same strict checks with pinned Playwright. It uploads validation evidence and
has no deployment job or Pages-write permission. Root/prefix checks now pass on
Windows and Linux. The existing 4173
preview continues serving `out`; alternate prefix exports use an ignored
`DOCS_EXPORT_DIR` without replacing it.

The first fully normalized root export exposed an additional 404: the framework
prefetched a public benchmark JSON file as a document route. `DocumentationLink`
now renders local public assets as prefixed native anchors, leaving actual docs,
entry, fragment and external links to the framework. The new routing tests cover
root/nested prefixes, queries/fragments and dot-segment normalization. The
strict suite opens a raw record and compares its received bytes to the export.

The second Linux run, [39449930514](https://github.com/Kiramei/baas-tauri/actions/runs/39449930514),
passed both jobs at `4bf911f1170eb6683a2e1ac437df4ab08769e7a4`. All four completed
reports have 334 cases, zero failures and identical source digests. At that
checkpoint, the report source files matched its checkout and the immutable tested
Git revision. `evidence/deployment-validation.json` retains report digests, grouped
counts, artifact identities and the earlier failed Linux run. This proves static
export behavior under the strict host; it does not claim a live Pages deployment
or successful game rendering.

The latest root checks also passed 24 search-recovery cases, updater/Android
presentation checks, 96 recognition scenarios / 864 steps, 76 exported-page link
checks and 425 general smoke cases. One smoke attempt using the long-lived 4173
preview stopped with browser `ERR_ADDRESS_IN_USE`. Its cause was not established;
the complete rerun passed on a temporary strict host without restarting 4173.
No emulator operation, application-media capture or performance sampling was
performed during this deployment checkpoint.

## Large Config Benchmark Checkpoint

The production native sync path now has 5,400 measured full-config pulls and
1,080 retained warm-ups across WebSocket, Pipe and SHM, with synthetic ASCII
fields of 1 KiB, 64 KiB and 1 MiB. Six transport permutations and rotating size
order balance positions. Every reply is validated in full after its Store
notification is timed. Any unsolicited config reference update fails the block;
the production protocol has no pull-request ID. This idle, single-request test
does not establish concurrent-request behavior or binary-image throughput.

The first private SHM probe failed restoration because the release Store's
remove handler only refreshed the config list. The corrected harness explicitly
pulls the config around cleanup. Its second probe and the formal run restored
the exact config/event bytes, production Store content and original SHM mode.
The failed probe remains separate in ignored cache and is not part of the chart.

`public/benchmarks/native-payload-current.json` retains every sample, block mean,
source hash and restoration check. Publication verified all ten recorded runtime
files against backend commit `d0a86a0`, comparing source text after CRLF/LF
normalization, and rechecked the release executable. The publisher refuses
changed measured sources rather than replacing their recorded digests. The
interactive client imports a separate compact summary bound to the raw record.

Both reader languages explain the exact clock endpoint, decoded JSON sizes,
full-content checks, distinct block-mean scope, timer resolution and inference
limits. Root-export browser checks passed all 48 size/metric/language/theme/
viewport combinations plus eight byte-identical native record navigations.
The Android media and recognition presentation checks were rerun against the
shared stylesheet/MDX changes; search-recovery and updater checks were rerun
against the regenerated search index. The general browser suite passed 425
cases on an owned temporary strict host. The Linux validation workflow now also
executes the large-config data tests and interactive browser matrix.

PC-window capture/input, Android-local measurement, binary-image transport,
real-game effects, other critical stages, final reader/privacy review and live
deployment remain open. The unfinished Android-local harness is still outside
this checkpoint and uncommitted.

## Android Preview Service Follow-Up

The preview checkpoint used `128983b8cb1317d01ec5f76022ecad3f766892f8`;
its x86_64 APK SHA-256 was
`2dc71138540405022d7797f7ef79d2cd2521a52720bb7a7bcaf3a8478e11b8d9`.
After explicit permission, the shared Shizuku ADB service was restarted once as
UID 2000; Root stayed disabled and the Android system process did not restart.
APK upgrades exposed an old BAAS user-service class loader pointing at a removed
installation. The service version now includes the APK installation path, so
Shizuku replaces only BAAS's own daemon after an upgrade. Native capture loaded
successfully afterward without another shared-service restart.

The preview health check now requires capture, successful GPU submission and
TextureView consumer progress. It counts distinct positive buffer timestamps,
not repeated redraw callbacks. All 39 native unit tests passed. The final passive
title-screen observation ran for 111.6 seconds; a 15-second physical display
recording retained 450 frames and visibly changing game content. UID blur was
applied locally with Gaussian filtering, with frame count and timestamps
preserved. The recording remains private diagnostic evidence rather than a new
public documentation asset or FPS benchmark.

Cold-start loading blackouts, SDK activities briefly launching on display 0 and
the earlier MuMu window-manager crash remain unresolved. Task recovery returned
SDK tasks to the virtual display in this observation; that does not prove all
startup paths are stable. No business task or game input was run. Configs and
events were compared with the exact baseline, the game/display were closed and
the owned orphan daemon from the earlier system crash was removed. Shared source
checkouts and their branches were untouched. Full Android game acceptance is
still false.

## Android Stop Icon Follow-Up

`36f08fd3` adds the missing destructive-foreground theme token and its white
value. The focused Tailwind compilation test failed before the fix and passed
afterward; all 230 frontend tests passed. The Android frontend, embedded Rust
assets and x86_64 APK were rebuilt. After explicit permission to interrupt the
open preview, the owned test app was updated to APK SHA-256
`b1324e14ffda8e5a4a92f726232fdf29f8af7b5021f85f0f1cb8e09097dde321`.

Browser checks cover 24 stop-control states and six unchanged start-control
states. The installed WebView's stylesheet matches the built bytes; a hidden
clone of the actual idle button confirms white stop-icon fill and stroke in
both themes without launching tasks. This is a color check, not fresh game
acceptance. Three empty crafting-priority fields normalized by backend startup
were restored to their exact pre-update values; configs and events then matched
the immediate pre-install baseline. The game/display stayed closed, and shared
source checkouts were unchanged. No new public media was added.

## Large Config Deployment Verification

Commit `24bc369fd16c33ab06c12308587c16618ce4683a` was pushed to the documentation
branch. Linux run
[39541366251](https://github.com/Kiramei/baas-tauri/actions/runs/39541366251)
completed both root and `/baas-tauri` jobs successfully. Its downloaded artifacts
were inspected alongside both Windows reports. All four source maps match the
tested Git objects and the current source files after CRLF/LF normalization.

The four strict deployment reports contain 1,336 cases with zero failures.
The separate payload reports add 192 verified control states and 32 native
raw-record navigations, with identical data/summary hashes across platforms and
prefixes. These counts remain separate in `evidence/deployment-validation.json`.
The evidence records report digests, GitHub artifact identities and
GitHub-reported artifact digests without claiming a locally rehashed ZIP.
The root preview at port 4173 serves the exact published benchmark bytes;
the alternate prefixed export did not replace that preview.

All 101 documentation tests passed with 9,507 assertions. Five offline Python
tests for the unfinished Android-local worker also passed, covering frame/color
decoding, texture arithmetic, timing endpoints, gesture validation and balanced
orders. That harness still pins an earlier APK and has not run on the device;
these tests supply no Android performance measurements. The shared `dev` and
`android-dev` tips remain unchanged. No Pages deployment or final PR was made,
and the full remaining scope above is still open.

## Android Local Measurement Checkpoint

The current installed `36f08fd3` / `b1324e14...` APK completed a formal embedded
Python run with 400 screenshot calls, 216 input calls and 86 retained warm-ups.
The worker ran in the verified `:baas_backend` process, using the unchanged
production AndroidLocalScreenshot and Control implementations. Screenshots cover
both direct adapter calls and the production 0.3-second script wrapper; input
covers click, swipe and long press. Frame/state tags, calibration colors, the
static texture ROI, exact input-counter increments and received gestures were
validated outside the relevant timing boundary.

The user explicitly allowed closing the current game for this measurement.
One active scheduler was stopped after capturing its configuration and event
selections. The resulting baseline matches those original selections; tasks
remain stopped rather than silently resuming account work. All measured input
went to the separately identified account-free fixture. The game was only
started to prepare the production display path, then stopped before fixture
input. No Root or shared Shizuku restart occurred; system and shared-server
process identities stayed unchanged.

Two earlier probes remain failures: a too-strict light-theme precondition and
a WebView startup reload invalidating the cached Store reference. The reload
failure also interrupted automatic cleanup. The exact original entrypoint was
restored from its verified private backup, measurement files were removed and
config/event/UI preferences were independently restored before retrying.
The harness now rediscovers the authenticated Store and restores disk ownership
before waiting for a reloading WebView. A subsequent 8-capture / 3-input probe
and the full formal run completed with every restoration check true.

The publisher verifies all measured harness hashes, five native Git objects,
the APK bytes and fixture sources. Pillow metadata is read from the verified
APK's nested requirements archive. Actual downloaded backend fingerprints are
recorded without assigning an unverified full Git revision. Public data excludes
device serials, process identities, tokens, user configs and private tracebacks.
All 616 formal calls and 86 warm-ups are retained; the interactive component
imports only a digest-bound compact summary.

The screenshot-confirmation input endpoint starts its PNG observation only
after API return. It includes that sequential observer and is not the earliest
visible response or the same endpoint as the desktop video observer. Zero ROI
MSE, zero observed repeat counters and zero failures do not establish game FPS,
game/business-task success, other-device behavior or long-term stability.
PC-window paths, binary-image transport and the full remaining requirements
remain unachieved.

## Mixed Chinese Search Correction

The unchanged updater empty-search test reproduced a false positive after the
numeric benchmark paragraphs were added. FlexSearch's CJK encoder split Latin
identifiers and numbers into individual characters; the impossible query
`zz_unmatched_updater_search_49375` matched a performance paragraph. The same
failure reproduced on an independent strict static host, with no browser error.

The shared encoder now retains individual Han characters but keeps technical
Latin identifiers and numbers as terms, with repeated-letter and numeric
splitting disabled. Both the build-time exporter and static client use that
same encoder. Export/import regression cases cover Chinese, mixed queries,
case-insensitive identifiers, identifier substrings, numeric versions and
unrelated queries. Existing browser queries and empty-result assertions remain
unchanged. Recovery/updater evidence also binds the encoder and exporter source.
The earlier unrelated preview-server chunk-load timeout is retained separately;
it was not used to explain away the reproducible false positive.

## Android Local Deployment Verification

Commit `437cde931c77ac9d54732862b6735d35ced3e6a1` passed both Windows exports.
The first Linux run, `39545996256`, passed the prefix job but timed out in the
root job after clicking a Chinese search result. No page error or failed
resource request was recorded. The failure artifact and screenshot remain
separate; its trigger has not been established.

Local CPU-throttled checks completed 20 current-index pointer rounds, 20
synthetic long-list pointer rounds and 20 synthetic long-list keyboard rounds
without reproducing that timeout. These are browser diagnostic fixtures, not
native application captures. With no product, assertion or timeout change, one
bounded full rerun,
[39547598569](https://github.com/Kiramei/baas-tauri/actions/runs/39547598569),
passed both Linux jobs at the same commit. Passing the rerun does not establish
the original trigger as fixed.

Downloaded reports were compared with both the current source files and tested
Git objects. Seventeen deployment source bindings now include the index loader,
shared mixed encoder and exporter. Four strict reports contain 1,336 successful
cases. Separate chart reports retain 192 large-config and 256 Android-local
control states, plus 32 raw-record navigations for each dataset. Data and compact
summary hashes agree across platforms and deployment prefixes. The aggregate
retains the earlier current-source failure and its unresolved status.

All 107 documentation tests passed with 9,581 assertions, alongside six offline
Android-worker tests. Current-root search recovery passed 24 cases, updater UI
passed eight, recognition passed 96 scenarios / 864 steps, the general suite
passed 425 cases and the static-link scan checked 76 HTML pages. The owned
measurement entrypoint/directory and config/event/UI preferences were restored;
the game and fixture were stopped. Shared source branches stayed unchanged.

The existing preview serves both current raw datasets byte-for-byte. No new
application media, live Pages deployment or final PR was produced. Before live
rollout, changed-encoder/index cache coherence still needs review; the static
search URL is not versioned. The unresolved CI timeout and all other remaining
requirements remain open.

## Android Preview Documentation Checkpoint

The Android guide now describes capture, EGL submission and TextureView
consumption separately. Live requires progress at all three stages; the first
positive sample alone is insufficient. Consumer counts use distinct positive
SurfaceTexture timestamps, which do not establish changed pixels or game FPS.
The architecture adds matching nine-node diagrams, counter diagnostics, the
RGB-content threshold, the CPU-copy boundary and the independent PNG/HTTP/BGR
screenshot path. All five implementation references in each language use the
measured APK's `36f08fd3` revision.

The source audit compared 22 files and 66 line-anchored references with pinned
Git objects and current files. BackendServicePlugin's installer reference moved
to `36f08fd3` and its shifted line range; its installer implementation is
unchanged. Older updater references remain pinned where files still match.
MAA-Meow's cached `aa9193f9a11eb1f1cfa71ed5fb917487cb94f3de` virtual-display
fallback was inspected for comparison. No external code was copied and no
native runtime change or additional permission was introduced here.

Root and `/baas-tauri` Windows exports both built 77 routes. Each passed eight
native-media cases, eight diagnostic cases, eight new pipeline cases and two
search navigations. Pipeline checks cover every counter, nine rendered nodes,
zoom/reset, scrolling to the last node and no page overflow. Screenshots were
visually inspected in mobile light and desktop dark modes. The public pipeline
report is the prefixed run; the root report is retained privately. These are
documentation checks, not new device measurements.

The root suite also passed 425 general cases, 24 search-recovery cases, eight
updater cases and a 76-page static-link scan. The general architecture check
now expects all three diagrams instead of the former two. All 109 documentation
tests passed with 9,750 assertions. An initial alternate export path outside
the Next project root was rejected; the successful prefixed export uses an
ignored directory inside `docs/`, leaving the root preview intact.

The original 400 capture / 216 input measurements and their 86 warm-ups were
not changed or repeated. No game session, scheduler, Root mode, emulator restart
or Shizuku restart was invoked in this checkpoint. Read-only process checks
confirmed the game and fixture remained stopped and the system/Shizuku process
identities remained unchanged. Shared development checkouts stayed clean.
Game startup/preview stability, live search-cache coherence and the rest of
the full remaining scope are still unresolved.

## Preview History and Search Interaction Diagnostics

A read-only retrospective of the 160-sample preview diagnostic started at
`2026-10-21T02:53:49.076Z` retained one waiting, four still, twelve black and
143 live observations over 111.617 seconds. The consumer counter remained
unchanged across an observed 6.969-second startup interval, then advanced to
2,653 by the final sample. This is sampled diagnostic history, not a new FPS
benchmark or continuous game/business acceptance. Its private raw JSON digest
is `9bc00ff0bb6d77cb4f5057fc2ea0dd443a7af53b3c4387f11448e58f96165a5b`;
the historical report records restoration and no business tasks.

At documentation commit `8f94c80b`, Linux run
[39553184936](https://github.com/Kiramei/baas-tauri/actions/runs/39553184936)
passed the root suite's 334 navigation/media cases, 48 large-config controls,
64 Android-local controls and eight raw links per dataset. The prefix job
timed out after clicking the Chinese `restart_deferred` search result in dark
desktop mode. Its screenshot and failure artifact are retained separately.
This repeats the earlier unresolved result-click symptom; it is not a green
deployment checkpoint.

The existing exception path did not persist that page's JavaScript errors or
pointer event order, so an empty top-level failure list cannot establish their
absence. The deployment harness now records bounded passive capture/bubble
events and saves per-page errors, selected rows and post-failure geometry before
closing the context. The navigation assertion, click and timeout are unchanged;
no application handler was modified. The instrumented local Windows prefix
suite passed all 334 cases, without reproducing the CI symptom. Instrumentation
can affect timing and a later pass must not be reported as a product fix.

The instrumented harness at `51a423f8` passed both Linux jobs in
[39554485945](https://github.com/Kiramei/baas-tauri/actions/runs/39554485945).
Downloaded reports were compared with current source digests: each prefix
passed 334 navigation/media cases, 48 large-config controls, 64 Android-local
controls and eight raw-record links per dataset. No application-handler change
occurred between the failed and passing runs. The earlier failure remains
unresolved; the historical deployment aggregate at `437cde93` was not relabeled
as evidence for this revision.

A separate local diagnostic used the real prefixed index, dark desktop mode,
four-times CPU throttling and an 80 ms pointer hold. All 30 rounds navigated,
without reproducing the CI symptom. Its private report digest is
`c85220c11f295617f9015b20e73c90424dbfe1874db39ec16762096724eba2de`.
These diagnostic rounds and CI checks did not operate the emulator or add
performance samples. No live Pages deployment, default-branch merge or final
PR was produced. The active documentation goal remains incomplete.

## Content-Addressed Search Index Checkpoint

The unversioned search endpoint is removed. A shared server builder creates a
content-addressed JSON artifact from the serialized index data and an encoder
format descriptor. Static pages carry the same revision/URL through the root
provider and a meta tag. The client checks the envelope before importing it,
separates cache entries by URL and expected revision, and avoids the browser
HTTP cache when downloading. This coordinates deployment versions; it is not
an adversarial signature or a client-side cryptographic integrity check.

Missing or mismatched artifacts now offer a localized explicit page reload,
including Enter from the input. Network, HTTP 503, invalid JSON and invalid
chunk data retain retry behavior and failure eviction. The legacy endpoint
does not hand newly encoded data to an older client; existing older JavaScript
may require a manual full-page refresh after the transition.

Both Windows exports built 77 routes and produced the same current artifact
revision `cd3da63a65d27913af683dbb140b8e284b1130f1e81b8f2dc47dffc921b138b6`.
Each passed 24 real-browser cache/reload cases and 335 strict deployment cases.
The cache negative control primes both an old content address and the legacy
address with long-lived HTTP headers; repeated fetches produce one request
each, confirming actual browser-cache use without Playwright routing. Current
queries still use the page's own artifact. Separate wrong-revision and 404
responses recover through button or Enter reload with a fresh download.

The root suite also passed 24 transient search-recovery cases, eight updater
cases, 20 service cases with 16 diagram interactions, eight Android-media cases,
eight Android diagnostics, eight preview diagrams and two Android search
navigations. General smoke passed 425 cases and links passed 76 pages. All 120
documentation tests passed with 9,929 assertions. The current preview serves
the exact versioned JSON bytes and returns 404 for the legacy URL.

The Linux matrix now includes the cache cases for both deployment paths.
The public cache report is the root run; the prefix run is retained privately.
Only documentation application code, tests and maintenance records changed.
No emulator, game, scheduler, Shizuku service or shared development checkout
was modified. No new public application media or performance samples were
created. The separate intermittent result-click failure remains unresolved,
alongside Android startup/preview stability and the full remaining scope.

## WebP Publication And Android Handoff

Android runtime investigation is on hold. The sanitized handoff is committed
and pushed on the isolated native branch at `cb8162a3`; no Android runtime
changes from that branch have been merged into `android-dev` or desktop `dev`.
The handoff distinguishes measured fixture behavior from unresolved game
startup, display placement and preview stability.

The prior content-addressed search checkpoint at `85ce0d13` passed both Linux
jobs in [39559373017](https://github.com/Kiramei/baas-tauri/actions/runs/39559373017).
Downloaded reports confirmed 335 navigation/media cases, 24 cache/reload cases,
48 payload controls, 64 Android-local controls and eight raw links per dataset
for each deployment prefix. This does not resolve the earlier intermittent
result-click symptom.

Current resource cleanup removed 157 unused legacy files (48,898,415 bytes).
Troubleshooting and PC settings now use current light-theme client captures.
Nine referenced game/system examples and developer diagrams remain. Historical
capture manifests retain their original filenames and digests.

All 285 remaining raster files were converted locally to lossless WebP,
including six controlled animations. Encoded size fell from 37,582,338 to
17,404,866 bytes. Every visible decoded RGBA pixel, animation frame count,
delay and loop count was checked against the input. Only 670 fully transparent
icon pixels changed hidden RGB values; these do not change displayed content.
The conversion strips embedded metadata and preserves existing blurred regions.
`webp-publication.json` binds the input/output digests and pixel proof separately
from original capture and benchmark records. Raw timing samples and measured
harnesses were not changed or rerun.

The new hash-matched local OCR pass decoded all 419 WebP frames without errors
or unresolved pattern findings. The full pre-conversion contact-sheet inventory
was visually reviewed, with legacy username-bearing unused assets removed.
The retained game nickname blur and native-game media remain tied to their
original Gaussian-blur evidence. OCR and contact sheets are review aids, not a
guarantee against every possible sensitive detail; raw OCR stays private.

The current root export built 77 routes and passed 124 tests / 13,688 assertions,
425 smoke cases, 76 static-link pages, 335 strict deployment cases, 24 transient
search cases, 24 cache/reload cases, 56 conditional-page cases, 96 recognition
cases with 864 trace steps, eight updater cases and 20 service cases. Android
reader checks passed eight media, eight diagnostic and eight preview-diagram
cases plus two search navigations. The current payload/local chart checks
passed 48/64 cases with eight raw links each. These are documentation/browser
checks and did not operate the emulator.

Branch/worktree cleanup decisions and preserved work are recorded separately
in `repository-cleanup.md`. Unmerged native/platform work, private archives and
another task's dirty React Native worktree remain intact. The old search-click
intermittency and the broader previously recorded validation limits are not
declared fixed by this resource migration.

The current prefixed Windows export also passed 335 strict deployment cases,
24 cache/reload cases, 48 payload controls and 64 Android-local controls, with
eight raw-record links per dataset. Both exports contain only WebP raster
assets and produce the same content-addressed index revision
`c9f127eccc155bc49f901f7bcdae0c2a9d5699918e02fb9a74ba28ca8bef0b5b`.
The 18 Python documentation/harness unit tests passed without device actions.

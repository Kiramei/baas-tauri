# Android performance review — 2026-10-24

Reviewer scope: local read-only inspection and this progress document only.
This reviewer did not access the device, run benchmarks, edit products or make
a release claim. Device baselines supplied by the main agent are recorded
separately below; prior acceptance remains bound to its exact APK in
`ANDROID_RUNTIME_VALIDATION.md`.

The hard stop is 2026-10-23 17:00 UTC / 2026-10-24 01:00 Asia/Shanghai.
The main agent owns deadline monitoring after this review handoff; no reminder
process or background build was created by this reviewer.

## Three concrete opportunities outside the frontend observer work

1. **Avoid full CPU readback on every preview frame.**
   `display_capture.cpp::available` holds the shared native mutex while mapping
   the hardware buffer, copying every RGBA row and classifying frame content.
   The GPU preview renderer also needs that mutex to consume its pending slot.
   A 1280 x 720 RGBA copy is 3,686,400 bytes: at 30 produced frames/s this one
   copy alone is about 110.6 MB/s, before PNG/bitmap copies. This is a calculated
   traffic budget, not a measured bandwidth or speedup. A demand-aware CPU
   snapshot cache, or moving buffer mapping/copy outside the publication lock
   with explicit callback/lifecycle ownership, is worth measuring. Do not
   simply remove `glFinish`: it currently protects AImage/GPU sampling lifetime.
   Regressions: screenshot freshness after input, three-stage frame progress,
   static-frame surface reattachment, start/stop races and memory ownership.

2. **Shorten screenshot critical sections and remove redundant serialization.**
   `ShizukuShellService.captureVirtualDisplay` performs placement checking,
   bitmap acquisition and PNG compression under `displayLock`; it creates a
   pipe-writing thread per screenshot. `ShizukuController.encodeCapture` then
   copies the pipe to bytes and Base64; local JSON RPC carries the string, and
   the Python adapter Base64-decodes, PNG-decodes and copies to a BGR array.
   Candidate changes: compress an immutable retained frame outside the display
   lifecycle lock with an ownership-generation check; use a bounded writer;
   consider an authenticated binary screenshot response instead of JSON/Base64.
   Preserve exact screenshot pixels and reject stale/closed display ownership.
   Measure capture/encode/transfer/decode times and payload bytes separately;
   include simultaneous gestures, disconnects, full-pipe readers and stop races.

3. **Bundle native preview diagnostics instead of four Binder reads per poll.**
   `BackendServicePlugin.gameNativePreview` queries two frame counters through
   `nativeFrameCounts`, then `hasVisibleFrame`, then `previewFocusDisplayId`.
   The shell path therefore uses at least four native service transactions per
   active diagnostic poll, besides its state checks. It applies UI layout and
   status both for the immediate cached report and the accepted query result.
   A single owned-display diagnostic snapshot plus equality-based native status
   updates can reduce repeated work without changing capture/input semantics.
   Preserve the immediate hide/layout path, generation/owner rejection of late
   results, off-main-thread Binder work and bounded query worker. Test stable
   repeated polls, menu hide during a pending query, session replacement and
   fullscreen geometry isolation; measure native transaction counts first.

These are source-backed candidates, not demonstrated causes of all observed
stalls. The main agent separately owns frontend observer/hidden-page polling
and log-render isolation; this review did not edit those areas.

## Manual control without stopping the scheduler — safety review handoff

The native owner's proposed policy is automation-priority **whole-gesture**
arbitration: before automation begins, cancel any current manual stream on the
same owned display; while automation runs, drop the entire competing manual
stream through its final UP/CANCEL. A manual lease remains authorization, not
an automation-stop request. Automation must never receive a false success ACK
for an input that was not executed.

Required boundaries communicated to the native owner:

- A failed manual CANCEL must not permit the automatic gesture to start.
- A manual DOWN arriving during automation must also be marked as a dropped
  stream; its later MOVE cannot resume halfway when automation ends.
- Back, release or delayed manual CANCEL must not cancel the automatic stream.
- Gesture, pinch, key and opaque shell execution need the same arbitration;
  root `SHELL_BEGIN`/`SHELL_END` must cover the actual operation.
- Preserve display/lease identity and stale-event rejection. Do not wait for a
  human long press in an automation RPC: the Python local RPC has a 15-second
  timeout and would otherwise stop the script on a manufactured busy error.

The native implementation is now frozen as user-service implementation version
43, with 118 native JVM tests passing. It uses a semaphore to serialize whole
automatic operations, confirms cancellation of an existing manual stream before
automation starts, and drops competing manual streams rather than making the
automatic RPC wait for a human hold. Display/lease generation checks and
fail-closed cancellation/input failure handling remain required. A real failure
must not be converted into an input-success ACK merely to keep a script alive.

The frontend helper changed from `stopForAndroidManualControl` to the read-only
`verifyAndroidManualControlOwnership`: the current profile may be running,
another profile's ownership is refused, and entering/returning from fullscreen
does not send scheduler Stop or Restart. Normal manual entry/exit therefore no
longer requests a scheduler state change. Automatic priority also means a human
gesture may be cancelled or ignored while an automatic operation executes;
this is not simultaneous unarbitrated injection.

These are implemented-source/local-test results, not new device acceptance.
The complete input path, long holds, multi-pointer preemption, old CANCEL,
session replacement and backend error behavior still need verification on the
new APK. This reviewer did not rerun the native suite or access the device.

## Frozen mainline performance changes and local tests

The main directory was frozen for the sole full Android build, now packaged as
the candidate recorded below. Product changes supplied by their owners are:

- Only the active preview page subscribes/polls. Layout results are cached,
  and DOM-mutation filtering is limited to relevant blocker/layout changes;
  cached hidden pages no longer run their own preview polling.
- The log-store subscription moved down into `ProfileLogView`, preventing
  routine log batches from rerendering the entire Home page.
- Frontend regression: 275 tests / 7,621 assertions and TypeScript checking
  passed. Native regression: 118 tests passed. These are distinct suites, not
  a combined device-performance measurement.

The three native opportunities above remain review candidates; they must not
be described as implemented or as measured performance gains from this work.

## Actual baseline on the older `9a90bdd7` APK

The main agent measured a paid-actions-disabled, mail-only validation copy.
Private evidence remains under the ignored Android-performance evidence
directory; raw game/account imagery and configuration are not publication
assets.

Cold-start first-home recognition took **85.333 seconds**, with 18 tentative
fallback taps. The sampled game sequence included `InitCatalog` around 25 s,
Chinese initialization around 40/50 s, the login page around 60 s, loading
around 75 s and home around 90 s. This was not 85 seconds of a fully loaded
home screen being misrecognized. Do not present a later timing difference as
27 seconds of recognition overhead removed, or otherwise attribute the whole
startup interval to the detector.

The actual old-APK preview-layout benchmark used 120 animation-frame callbacks
per workload, approximately four seconds, and counted `getComputedStyle` calls:

| Workload          | Older APK count | Same benchmark on new APK                   |
| ----------------- | --------------: | ------------------------------------------- |
| Idle              |             108 | 108 — no reduction                          |
| Log subtree churn |             108 | 99 — single run, not an established speedup |

The private baseline is `baseline-preview-layout-benchmark.json`. The new-APK
idle comparison also counted 108 calls over 120 animation-frame callbacks,
approximately four seconds. This does not demonstrate an improvement. A new
log-churn run counted 99 calls, without repeatability evidence. Keep the same benchmark definition and report
actual window lengths when comparing; animation-frame callbacks are not a claim
of fixed device FPS.

## Conservative startup guard — local result only

The version-1 startup guard requires both the spinner layout and complete
recognized words with raw character confidence at least 0.8. Only a strictly
validated trailing dynamic-punctuation suffix may have lower scores; uncertain
word characters cannot be dropped to manufacture a positive match. Existing
login-template detection is checked first. The guard adds no clicks and does
not change the home-page definition.

Raw CN OCR is attempted first. The narrow alternate path for the exact
`InitCatalog` candidate uses English OCR on a Pillow LANCZOS 2x image. OCR HTTP
connect/read timeouts are 0.3/0.8 seconds, with a two-second result cache; this
does not imply a hard bound on the entire underlying screenshot/RPC flow.

The reported focused regression ran 67 tests with one skip and the remaining
tests passing. Private image replay passed the 25-second English-2x candidate
and the 30/40-second raw-CN cases; a 50-second case with uncertain word scores
remained rejected. These replays are not new-device startup acceptance and
must not be used to promise a smoother or faster startup before measurement.

## New candidate — runtime acceptance failed

The main agent built and audited the candidate and verified the installed
`base.apk` SHA-256 as
`7d3ad42e3530239526e8ecee2869a0160a449d0bdec6e57d12f5efaceacf537d`.
The reviewer did not independently repeat that verification. Package identity
and successful installation are not runtime acceptance.

The new mail-only cold-start test remained black for more than 160 seconds.
The owned virtual display was VD8, with `frameState=black`, `ready=false` and
`focusDisplayId=8`. Logs repeatedly reported:

> Game focus recovery failed: privileged focus shield not verified top input window

The focus protection was not bypassed. The root cause is unresolved; these
observations do not establish whether the new input arbitration, the startup
guard or another component caused the failure. There is no accepted first-home
timing or actual startup-recognition improvement from this run.

Fullscreen entry and return retained `running=true` and `current_task=mail`,
with no intermediate scheduler Stop/Start. That confirms only the observed
scheduler-control behavior: because the game remained black, actual manual
control, whole-stream arbitration/preemption, long holds, multi-touch and CANCEL
could not be accepted on this candidate. Older APK acceptance must not be
transferred to the new implementation.

The new idle layout benchmark was 108 `getComputedStyle` calls per 120 animation
frames, approximately four seconds, equal to the older `9a90bdd7` baseline.
The new log-churn workload counted 99 calls versus 108 on the older APK in this
single run. This small single-run difference does not establish a reproducible
speed improvement; idle work was unchanged and no broader speedup was verified.

### Verified rollback and cleanup

Around 16:53 UTC, the main agent completed an in-place `install -r -t` rollback
with result `Success`. The installed `base.apk` SHA-256 was verified as
`9a90bdd70eef0cf45e73877697f56e7039a56c76faa7d0763fd89495dfe9d6f8`.
The app then reported `uiReady=true` and `allDataInitialized=true`.

Both original profiles' configuration and events were compared as parsed JSON
against their pre-startup snapshots and were completely unchanged. The owned
test profile was backed up to the private `pre-rollback-final-snapshot.json`,
then deleted using its exact UI confirmation and verified absent. The original
safe daily profile was selected again.

Final state: zero Stop buttons, game process absent, native preview
`active=false` / `displayId=null`, and Shizuku display ID `-1`. The shared
Shizuku service remained granted and running as UID 2000. There were no
temporary ADB forwards, observers or Kotlin compilation processes remaining.

The game was not restarted after rollback and no new full acceptance run was
claimed. Prior runtime acceptance remains bound to the exact older APK and
its recorded session; the failed new-candidate results above remain preserved.

## Separate legacy-compatibility experiment

The compatibility research is isolated on `codex/android-legacy-shizuku` in its
own local worktree and has a separate document. Its owner reported 42 tests and
14 source compilations. It is not merged into the frozen mainline, has not been
device-tested and does not establish compatibility with older Android/Shizuku
versions. This progress record does not claim those experimental changes are
included in the new mainline APK.

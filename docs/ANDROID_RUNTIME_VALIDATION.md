# Android runtime validation

Latest snapshot: [goals and current status, updated through 2026-10-25](ANDROID_GOALS_AND_STATUS_20261024.md).
The 2026-10-24–25 continuation has the limited physical-ARM results below. The
earlier failed coexistence/startup candidate and its rollback remain historical
checkpoints later in this document. No result transfers between APKs or providers.

## Sticky navigation correction — 2026-10-25 Asia/Shanghai

The subsequent ARM64 debug UI patch is **169,257,523 bytes**, SHA-256
`b9e36470ef9fc5c9fb1eefd023eaea035c5dc5d046bc42b12ec4adf7583bbe40`;
the installed Redmi K30 APK hash matched. Low-performance mode removes box
shadows, including the shadow previously used to cover the 16px gap above
sticky settings/configuration navigation. An opaque pseudo-element now covers
that gap, sharing the scroll-padding variable without changing native insets.

Android frontend/type/translation checks and ARM64 debug packaging passed.
On the installed APK, 20 settings and 20 configuration geometry checks passed
across low-performance mode on/off, dark/light CSS palettes, and scroll offsets
0/100/155/260/600. A physical screenshot at the original settings offset confirmed
that the title no longer shows above the search bar. These are UI-only results;
the earlier runtime, gesture, and mail-flow observations below remain bound to
their original APK identities.

## Continuation checkpoint — through early 2026-10-25 Asia/Shanghai

The user explicitly requested continued development and allowed physical-device
testing after the previous 01:00 Asia/Shanghai stop. The old stop is a historical
boundary, not an active prohibition on this continuation. This remains a scoped
development record, not release sign-off or completion of all Android goals.
The original `20261024` filenames are retained; final device observations and
cleanup crossed midnight into 2026-10-25.

### Latest ARM64 identity and local verification

The final ARM64 debug candidate for this continuation is **103,902,521 bytes**, SHA-256
`c4690df37501a58cdc4161deebd19ff299a81ba1f8aa5b2ffeae80edd7b36d5b`.
The installed APK hash matched exactly. APK ZIP CRC and v2 signature passed;
all 183 frontend files, 12 native libraries, and the bootstrap/config_watch
Python sources inside `app.imy` matched the audited source/build outputs
byte for byte. This identity binds the latest device results below. It is not
release sign-off or a transfer of earlier candidates' input/performance results.

Local results for the current source are 275 frontend tests / 7,621 assertions,
142 native JVM tests, 42 Rust library tests, and 117 Android Python tests
(116 passed, one existing optional skip). TypeScript, production frontend builds,
and 838 translation keys across seven languages passed. C++ frame-content and
callback-draining tests, including 100 session reopenings, passed; ARM64 and
x86_64 API 24 native objects compiled with `-Wall -Wextra -Werror`.
The 11 added native tests cover picker binding, the exact seven-field keep
contract and owner identity, among related lifecycle boundaries. These are JVM
and debug-build results, not an installed R8-minified release acceptance.

Changes include capture publication-lock isolation with a callback lifetime
fence, root Binder identity handling, sanitized strict focus diagnostics, and
Activity-owned native UI sessions. The capture still performs per-frame CPU
readback and retains `glFinish`; this is not zero-copy capture or a measured
reduction in bytes copied. Worker and in-flight session ownership survive an
Activity relaunch; an old owner's callback or destroy cannot mutate its successor.
The Tauri picker compatibility helper rebinds activity-result handling after
configuration recreation, with an exact seven-field ProGuard keep contract.
Actual recreated-Activity save/open behavior passed on this debug candidate;
that is not evidence that every minified release variant works.

First-run download correctness now has at most three attempts, a pinned resolved
commit SHA, and full ZIP CRC validation before extraction. Kotlin and Python
claim bootstrap once per backend process, preserving the original installation
or service error when reconnects or diagnostic transport fail. The fallback
health endpoint returns 503, and explicit process restart remains available.
Regression tests cover interrupted transfers, bad ZIPs, concurrent reconnects,
occupied ports, first-error preservation, real local HTTP 503 and restart. The
isolated emulator also performed a real fresh backend download/start. These
facts do not establish faster startup or a general network-reliability rate.

### Redmi K30 / Android 12 / API 31 / physical ARM64 / root Shizuku

At the user's request, both old official and Dev BAAS packages, their configuration
and preferences were backed up before uninstall. The game and shared Shizuku were
retained. MIUI initially refused installation; after the user re-enabled USB
installation, the latest package installed and its installed hash was verified.
Installation is therefore no longer the current blocker.

This provider uses the system-identity display backend. It does not exercise the
Android 12 shell shield path that failed on Redroid, and cannot prove that older
shell failure fixed.

- The latest app stayed in the same process through one `font_scale`
  `1.0 → 1.01 → 1.0` round trip, triggering two Activity recreations.
  Native Shizuku calls recovered after recreation,
  and both system Save and Open document pickers actually worked. This covers
  that configuration-change/picker lifecycle, not arbitrary process death,
  screen-off behavior or long unattended use.
- System Documents saved `ZIP_Acceptance.zip`, **4,960 bytes**. ZIP CRC and
  `config.json`, `event.json`, `switch.json` were verified. The source test copy
  was deleted through exact UI confirmation, then the system picker selected
  that ZIP for import. Waiting ended, the editor closed and the imported profile
  appeared selected. All three imported JSON files were parsed and compared
  equal to the exported data; the imported test profile was then precisely
  confirmed and deleted through UI.
- Copy, rename to `ZIP_Acceptance`, and exact confirmed delete were exercised
  again on this same latest APK. Persisted storage contained only the original
  safe Bili profile and `default`. The temporary phone ZIP was removed; private
  backups remain in the ignored local evidence directory. The old Download test
  APK was precisely replaced with this candidate's contents.
- The final mail-only run began from a genuinely cold game and used automation
  without a human game tap to advance startup. Both before and after the run,
  safety checks confirmed only `mail` enabled, the other 25 tasks disabled,
  all pre/post lists empty, purchase/shop values zero, and `autostart=false`.
- Three consecutive `Recognized explicit Android CN initialization status;
  waiting without tentative clicks` log entries established the conservative
  wait inside that known initialization phase. Tentative clicks still occurred
  after leaving known initialization. No A/B startup comparison was performed;
  this is not a claim of globally faster or entirely click-free startup.
- The algorithm subsequently recognized login/news/`main_page`, entered
  `mail_menu`, ran `COLLECT mail reward`, handled the `reward_acquired` popup
  and returned to `main_page`; the visible UI finished at the real game home.
  Every individual mail item was not audited, so stage logs or `next_time`
  alone do not prove every reward was collected. No balance values or claims
  attributing balance changes are published. Explicit Stop left all latest
  health states `running=false`, `current_task=null`, `waiting_tasks=[]`.
- Switching through the UI to Light visibly changed the native inline toolbar
  to a white background with black icons. Its actual middle button entered
  landscape while retaining the game process; explicit display-0 BACK returned
  to portrait. The original System/dark theme was restored, and normal frontend
  close removed the game process and owned display. The same shared Shizuku
  service remained running/granted, and `font_scale` was restored to `1.0`.
- The latest APK's separate UI monitor recorded **15,082 samples / 757.8844 s**
  (about 12.63 minutes), maximum event-loop gap **296.6 ms**, and no gap above
  500 ms. It still recorded **48 long tasks, maximum 186 ms**. This mixed window
  included cold startup, pages, file pickers and theme operations. Its workload
  differs from `67291e03`; the figures are not a speedup comparison or evidence
  of long-term stability. The injected monitor timer was stopped afterwards.

Final cleanup returned to the safe Bili profile home with only Bili and `default`
remaining and no Stop button. All backend statuses were idle with an empty queue;
native display ID was `-1`, and the game process was absent. Shared root Shizuku
remained running/granted, font scale was `1.0`, and System/dark appearance was
restored. Only this task's temporary ZIP, profiles, ADB forwards, APK/dump tooling
were cleaned up; pre-existing external forwards were retained. The phone's
Download test APK contains `c4690df3`, not the earlier `e09f2d60` contents. Local
evidence, old APKs and configuration backups remain private under `.cache`.

These observations establish limited real-game preview, actual input,
fullscreen/return ownership, Activity relaunch, ZIP/configuration UI, Light
toolbar styling and one cold mail automation flow.
They do not pass the complete long-hold, multi-pointer, automation-preemption,
late-CANCEL, floating-menu drag, complete theme matrix, cold-start A/B,
screen-off or long-duration matrix, nor an R8 release install. General UI-stall
resolution and reproducible speed improvements are not established.

### Earlier continuation candidate `67291e03` — separate historical evidence

This ARM64 APK was **103,895,888 bytes**, SHA-256
`67291e03627c1840af50ccb6f94463df3b29e341af241c1adf5edc838a19c3f4`.
Its installed hash, ZIP CRC, 183 frontend files and 12 native libraries matched;
its v2 signature was subsequently verified too. Native JVM tests at that
checkpoint numbered 131. The following observations belong only to that APK:

- Two same-process font-configuration relaunches retained working
  `nativeShizukuStatus`, followed by real-game native `Live`. The actual middle
  native button opened landscape, a title-screen touch reached game home, and
  display-0 BACK returned while retaining the game process and owned display.
- During the first safe mail-only attempt, fullscreen entry/return retained
  `running=true` / `current_task=mail` without intermediate Stop/Start. A
  character illustration had its game UI hidden; loading waited about 61 s
  before explicit Stop. This attempt did not complete or claim mail.
- After restoring the visible home, the second attempt opened mail, confirmed
  inventory full on two fresh frames and pressed only X, logging
  `SKIPPED/unclaimed` without resource consumption. It returned to real
  `main_page` and was explicitly stopped idle. This skip is not overwritten
  as a reward claim by another candidate's later `reward_acquired` stage.
  AP, credits and pyroxene OCR also refreshed from a new game frame into its UI;
  the balances and account imagery remain private.
- Export received its backend ACK, but Tauri `dialog.saveFileDialog` used the
  old recreated Activity's `unregistered ActivityResultLauncher`, and
  `CREATE_DOCUMENT` did not open. That real failure is preserved historically;
  the latest `c4690df3` actual ZIP round trip above resolved this blocker.
- Its UI monitor recorded **20,878 samples / 1,045.288 s**, maximum event-loop
  gap **385 ms**, no gap above 500 ms, and **15 long tasks, maximum 140 ms**.
  It was not a zero-long-task run. These figures do not belong to `c4690df3`,
  are not compared across differing workloads as a speedup, and do not establish
  long unattended stability.

### Android 15 / API 35 / x86_64 / shell-provider fixture

The separate isolated APK SHA-256 is
`8e71086a9c2819d4e81536d00c16e49cdbd149bfb54a78ae25d6bae3c8c06eb9`.
This was an Android 15 x86_64 emulator with Shizuku shell UID 2000, not a physical
phone or signed-in game. Its local native input fixture had no permissions,
network access or account and was installed after confirming its package name
unoccupied. No scheduler task or script/manual coexistence run was attempted.

- A real fresh backend download/start reached service connection. The owned
  native preview showed the fixture's animation and `Live`; the actual middle
  control entered landscape. Normal return retained its process and owned
  display; closing removed both.
- The service reported effective VD flags `8`. Focus recovery failed with
  `The BAAS focus window did not acknowledge DOWN+CANCEL`. The cause of the
  requested display capabilities being unavailable was not separately proven.
- Primary-display focus did not remain within the safety driver's verified
  BAAS target. The driver refused the next gesture before DOWN, did not inject
  directly into the fixture's owned display, and did not relax the guard.
  Final fixture evidence was `seq=0`, `completedGestures=0`, `cancelledGestures=0`,
  `maxPointerCount=0`, `activeGesture=false` and `violationCount=0`. Opening BAAS
  controls or dismissing the emulator's prompt is not fixture-input acceptance.
  Long holds, multi-pointer/CANCEL and automation-preemption end-to-end checks
  remain unpassed.
- The owned display was closed; fixture and isolated validation packages,
  temporary tools and forwards were removed. Shizuku remained running. Other
  BAAS installations and real game accounts were not modified by this test.

Earlier Android 12 shell failures, this Android 15 refusal, and the unmerged
legacy-compatibility experiment remain separate unresolved scopes. Only source,
tests and sanitized documentation are deliverables; APKs, raw logs, account
images, device connection identifiers and private backups remain local. This
work does not automatically create a PR or merge into `android-dev` / `dev`.

## Historical checkpoints — 2026-10-23

Date: 2026-10-23. Work branch: `android-dev`, based on `326760f`.
This is a scoped development record, not release sign-off. No device connection
identifier, account screenshot, token or private configuration is a publication asset.

## Device evidence already obtained

The connected test environment is Redroid, Android 12 / API 31, x86_64 with
ARM translation, shell-mode Shizuku (UID 2000). It is not a physical ARM phone.
BAAS was installed afresh; the game and its signed-in account already existed.
The app owns a separate 1280 x 720 game display. Root and Accessibility were
not used for the automation path.

The installed build that completed the cycle is identified by APK SHA-256:
`0df8333bff09a783d5cd6126533fdf4da465eb4b3f7ff17538f203beba972ee8`.
It includes the import/export fixes and the initial Android 12 focus handshake,
but **not** the subsequent fullscreen, theme, polling-worker or resource-card fixes.
Do not attribute that run to a later APK merely because it shares a version name.

Observed end-to-end boundaries:

- Fresh BAAS setup downloaded the backend and initialized the native OCR runtime
  without copying a preinstalled backend into app data. Backend source:
  `Kiramei/baas-dev`, commit `4d58c420208acfbb183185f12dd58ce11745d902`.
- Profile creation, native-file-picker ZIP import, copy, rename, confirmed delete,
  task-switch persistence and configuration persistence were exercised through UI.
  Successful import selected the resulting profile and closed the editor.
- Export produced a valid ZIP containing `config.json`, `event.json` and
  `switch.json`; ZIP contents were checked, not just the save-dialog result.
- Automatic game startup reached Unity initialization and game loading without
  a diagnostic touch being injected into the game to unstick startup.
- The actual app Start button initialized screenshot and control methods as
  `android_local`; the script then ran the configured cycle on the owned display.
  Legacy log labels mentioning UIAutomator do not mean its third-party package
  or an Accessibility service supplied control.

## Consented free-daily cycle

The user authorized free daily operations and prohibited paid/premium-resource
spending. Exactly seven configuration entries were enabled: `cafe_reward`,
`lesson`, `group`, `mail`, `collect_daily_power`, `rewarded_task`, `collect_reward`.
The last two daily-reward entries share the backend reward-collection module;
seven scheduled entries do not mean seven distinct business implementations.

All ticket purchases and shop refreshes were zero, shop selections were empty,
invitation/exchange and acceleration options were disabled, and all pre/post
task lists were empty. No gacha, recharge, premium purchases or AP-spending
normal/hard stage sweeps were enabled. The installed café implementation locates
students using a drag routine, exits the gift view and then pats students; its
source has no gift-confirmation call. The legacy `patStyle` value is not read by
that implementation and must not be treated as a spending safety switch.

The observed run initialized at 18:15:40 local time, progressed through café
earnings, lessons, club, mail, task rewards and all three bounty sweep types,
then logged `all activities finished, return to main page` at 18:20:38.
It returned to the actual game home and the visible Stop button was then used;
backend status confirmed `running=false` and an empty queue. Idle scheduling
remaining alive before Stop is expected with the configured no-action ending.

Completion was checked against live task transitions, reward/sweep outcomes,
game screenshots and final backend state, not only future `next_time` values.
Private raw evidence is retained locally, outside tracked/public files.

## Failures found after that run

1. Menu hide/show exposed an Android 12 focus-recovery failure. The original
   `TYPE_SYSTEM_DIALOG` shield could sit below an existing game input window.
   The strict guard correctly refused to send a touch through to the game.
   Initial startup success therefore did not prove focus recovery was fixed.
2. Home resource OCR sampled transitional text and used an outdated credit
   region. The Android file-watch stub never emitted changes, so cached resource
   cards did not refresh after backend writes.
3. UI stalls were reported at irregular intervals while game animation continued.
   Code inspection confirmed synchronous update networking in Android IPC,
   main-thread native-preview Binder polling competing with long focus/gesture
   operations, and synchronous batched frontend-log persistence. These are real
   blocking paths, **not** a timestamp-correlated diagnosis of every reported stall.

## Current candidate and remaining acceptance

Local changes address import framing/callback IDs, export capability, Android
resource polling and conservative full-line OCR, native UI worker isolation,
update-query single-flight/deadlines, batched background log writing and preview
theme colors. The new middle action is in-app landscape manual play on the same
native game session, with a draggable menu offering return-to-preview and close.
The shared home log heading no longer displays a row count on any platform.

Stopping the scheduler and seeing `running=false` are not, by themselves, proof
that every asynchronous backend click thread has finished. Manual play therefore
also requires a native exclusive-input lease: new automation input is rejected,
already-entered automation must drain within a bounded wait, and touch packets
are scoped to that lease. Returning to the preview leaves automation suspended
and does not restart the scheduler. An explicit new Start or trusted UI display
preparation may reopen admission; ordinary backend clicks, launches and opaque
shell commands cannot reopen it themselves. This does not claim that every old
backend thread has exited or that arbitrary external backend clients carry
per-run input generations.

Local verification for the latest `440fbb0f` candidate (not device acceptance):

- Frontend: 271 tests and 7,604 assertions passed; TypeScript checking passed.
  Desktop and WebUI production frontend builds passed in separate output folders.
- Native Android: AIDL/Kotlin compilation and 107 JVM unit tests passed, including
  input admission/draining, stale leases, late-acquire cleanup, touch deadlines
  and trusted preparation after a suspended manual session, plus the shell-process
  identity and verified own-host bootstrap boundaries.
- Rust: 36 library tests plus seven native-dispatch/ACL contract tests passed; the
  Android x86_64 target type check passed.
- Python Android adapters: 71 tests ran, with one skipped; the remainder passed.
  The C++ frame-content regression compiled with warnings treated as errors and
  passed.

The earlier `367bbc2a` build recorded 262 frontend tests / 7,588 assertions,
96 native tests and 32 Rust library tests / six dispatch contracts. Those are
historical results, not the totals for the latest candidate.

The initial complete x86_64 debug candidate was rebuilt after source freeze,
including frontend assets, Rust, AIDL/Kotlin and native libraries. Its APK is 110,344,127
bytes, SHA-256
`367bbc2ab31e2abe4d83a6c7c7bd8ec040d7ce2763a25970e35c5e1bb8fcf2bc`.
It is a local development artifact, not a physical-ARM or release build.
Package auditing matched all 183 frontend files and 12 native libraries against
the rebuilt outputs, verified the updated Python modules and native DEX classes,
and passed ZIP CRC and APK v2 signature checks. This verifies package consistency,
not runtime behavior on the device.

Device operations were stopped while the user used the device, then resumed only
after their explicit permission. Current configuration, WebView preferences and
the installed APK were backed up before a successful in-place installation of
the candidate above. Installed APK hashing matched the candidate; both profiles
and the app theme remained present, and the visible log heading had no count.

The first startup check rejected this candidate for runtime acceptance: Android
launched the game on the owned display, but the Rust native-command wrapper
failed with `invalid type: map, expected unit`. The new Kotlin worker returned
an empty JSON object for a void action, while the Rust wrapper expected JSON
null. Consequently preparation did not finish and the UI never claimed the
display, leaving a black preview. Do not count a launched game process as a
successful UI flow. A compatibility fix and rebuilt APK are required before
continuing past this boundary.

The next complete debug APK was 110,528,979 bytes, SHA-256
`b4f7ad261ca439e39b66ef562c1ff8c02d6a1d5af700c210a558c6d894cdd13a`.
Its installed hash matched. A strict native void-ACK decoder accepts only null
or an empty object; 36 Rust library tests and six integration contracts passed.
The actual UI preparation now finished and claimed the owned display. Native
toolbar colors followed the current monochrome theme, opening a profile menu
hid the native host, and closing the game removed its display and process
without a failure toast. Arbitrary touch tests used a clearly labeled,
account-free, permission-free temporary fixture, not the signed-in game.

This APK is still **not accepted**: Android 12 shell-process AppOps bookkeeping
threw a `SyncNotedAppOp` null-package exception while creating the focus shield,
so the real game's preview stayed black. The fixture rendered live, but the
fullscreen action was rejected by the Tauri command ACL because its new command
was missing from the mobile allowlist. These are separately reproduced runtime
failures; neither a live fixture nor a successful prepare ACK proves game
fullscreen or the safe cycle works. Both require another complete build.

The next APK (110,535,695 bytes), SHA-256
`2beb27ad1c01c117ceabb0f41da37a26d0a79dcdb85277eade796dbf905d737c`,
installed with a matching hash and kept all four original/test profile tabs.
The fullscreen command reached native landscape mode on the same fixture
display; harmless automation shell and explicit resume calls were refused
while manual mode was active. Real-game focus still failed closed: Shizuku
initializes its unbound process with the host application's `Application`,
which the initial identity guard did not yet recognize. The follow-up fix must
accept only that verified own-host bootstrap case, not arbitrary app identity.

Fixture input acceptance was interrupted by a serious test-driver failure at
21:01:33 local time: its first primary-display DOWN used pointer ID 17, and this
Android 12 build aborted in `InputTarget::addPointers`, before the fixture
received any event (`seq=0`). Android's zygote/system services restarted
automatically. The test was stopped; no repeat of that input is allowed.
Crash logs and the complete system tombstone were saved privately. The shared
Shizuku server survived and was not manually restarted. No account game task
was running. The old driver is rejected for further device use; any replacement
must use conventional low pointer IDs and explicitly avoid this known platform
boundary. This interrupted run is not a passing fullscreen input or daily-cycle
result, and its system restart is not evidence of a BAAS WebView freeze.

The subsequent own-host bootstrap fix is packaged in the 110,536,487-byte APK,
SHA-256 `440fbb0f906d70e6904d6941536cc133cab4ec70af242216c640317782d81949`.
Its installed APK hash matches; native identity/gate tests total 107 passing,
frontend tests total 271 passing (7,604 assertions), and seven native command/ACL
contracts pass. The full package audit verifies all 183 frontend assets and 12
native libraries, generated ACLs, DEX classes, Python bundle, ZIP CRC and the
original debug signing certificate. The Shizuku user-service implementation is
42, with APK-path-derived service identity.

After the interrupted system session recovered, the shared Shizuku process was
still alive but both BAAS and the Shizuku manager reported the service not
running. Opening the manager did not reconnect it. At that checkpoint, no
shared-service restart had been performed; permission was requested before
that broader recovery action, and real-game preparation and the safe cycle
remained unverified. The user subsequently restarted Shizuku themselves before
the checks below. Current configuration and the original backup remain intact.

## Latest `440fbb0f` device checks

These observations belong to the APK identified above, after the user's manual
Shizuku restart. They do not erase the earlier rejected builds or the unsafe
test-driver failure. Raw process/task identifiers and account-bearing evidence
remain private.

### Real-game preparation and native fullscreen

- The actual UI preparation completed and claimed the owned 1280 x 720 display.
  The game's Unity activity was resumed and had window focus. An initial black
  startup lasted approximately two minutes; its main thread was observed in
  `D` state at `folio_wait_bit_common` while the host had substantial memory/I/O
  pressure. It subsequently initialized and reached a live native preview on
  its own, without a diagnostic game tap or a further code change. This supports
  a host-I/O explanation for this particular startup delay, not for every
  reported UI freeze or black frame.
- Entering native landscape fullscreen, opening its menu and returning to the
  portrait embedded preview kept the same game process, task and owned display.
  This was an in-app presentation change, not a game restart or an external
  activity takeover.
- Harmless automation shell `true` was rejected during manual control and
  remained rejected after returning to the embedded preview. Automation did
  not restart automatically. Explicit resume was also refused while manual
  control was active.
- Closing the actual game completed normally, without a failure toast.

### Account-free input acceptance and cleanup

The replacement fixture APK was hash-verified as
`845e0fd46ed3023fa23a61bc7e764f5ea51116b3ab38c62d09a672be80abe112`.
It used only conventional pointer IDs `0` and `1`; the rejected pointer-ID-17
driver was not retried. Input followed the normal primary-display UI through
the fullscreen TextureView to the fixture's owned virtual display, rather than
injecting directly into the fixture display to bypass the new frontend path.

- A tap, a 450 ms swipe producing 400 game-coordinate pixels of motion, and a
  1,204 ms long press reached the fixture.
- A two-finger stream held IDs `0`/`1`, moved, lifted pointer `1`, then lifted
  pointer `0`. Multi-pointer cancellation did not increase the completed-gesture
  count. Back while held cancelled the stream; fresh re-entry then delivered
  exactly one new tap. No invalid stream or active-pointer residue remained.
- Dragging the floating control, opening its menu and dismissing the menu by
  tapping outside left the fixture's event sequence unchanged at `48`: these
  controls did not pass touches through to the game.
- Closing from the floating menu reported fullscreen inactive, removed the
  fixture game process and restored portrait orientation. The fixture APK was
  hash-verified again before uninstalling it. Its temporary profile was removed
  through the confirmed UI delete flow; both original user profiles remained.

### Responsiveness and safe-cycle status

The completed `440fbb0f` UI-monitor session contained 15,772 valid samples, with
a maximum observed event-loop gap of 410.1 ms, no gap above 500 ms and no
reported browser long task. Earlier interim snapshots contained 4,420 samples
(maximum 410 ms) and 2,056 samples (maximum 391 ms). These observations apply
only to that monitored session; they do not establish long-term responsiveness
or prove that every irregular stall is fixed.

A separate safety-checked copy of the user's daily profile was started through
the visible Start control. Only the seven consented entries were due, with all
ticket purchases/shop refreshes zero, shop lists empty, invitation/exchange and
acceleration disabled, and empty pre/post task lists. This attempt is **stopped
and incomplete**, not a seven-entry success:

- The mail claim attempt opened the inventory-full notice, “以上道具的库存已满。
  请先整理库存。”, with AP at `999`. Successful mailbox collection was not
  established. That APK's mail path returned after the claim click without
  checking its outcome, so the following `mail next_time` log is not
  evidence of a successful claim.
- The next `collect_daily_power` entry stalled while returning to the home
  page: its detection loop reported loading for approximately 82 seconds while
  the inventory notice remained. The saved implementation checks loading
  before popup reactions, and its loading loop does not share the outer
  detection timeout. This is a reproduced task-recognition failure, not proof
  of an Android UI event-loop freeze.
- The visible Stop control was used. The authoritative backend state confirmed
  `running=false` and an empty queue. No inventory sorting, AP-consuming sweep,
  purchase or generic confirmation was authorized to bypass this boundary.

After this attempt, the script remained stopped and the native game UI was
closed; the native status reported no owned game display (`shizukuDisplayId=-1`)
before preparing the subsequent candidate.

The `440fbb0f` build therefore passed the scoped display/manual-input checks
above, but not the latest complete daily-cycle acceptance. Today's genuinely
already-claimed rewards or exhausted free tickets may be legitimate no-op
results; an inventory-blocked claim or detection failure must be recorded as
such instead. At that checkpoint, a narrowly verified inventory-full exit and
a rebuilt candidate still required their own runtime check before another
cycle could be accepted.

Checks outstanding at the `440fbb0f` checkpoint (later scoped results below):

- Repeat setup/import/export/start/stop regression on the latest candidate as
  appropriate, and verify resource OCR values against the game and UI updates
  against disk.
- Extend the observed fullscreen/inline and menu behavior to repeated profile-menu
  hide/show, theme changes and background/resume without process restart or task
  transfer to display 0. Keep arbitrary input tests on the safe fixture, and check
  that no injected game input or temporary focus window leaks onto the primary display.
- Correlate UI event-loop gaps, native command durations and Android main-thread
  stacks with actual stalls on an otherwise quiet host. A passing unit test or
  reduced polling does not prove the phone's stutters are resolved. Some older
  synchronous `system_log` callers can still wait on storage; evaluate measured
  remaining stalls rather than claiming all blocking paths are gone.
- Verify a strict inventory-full stop/exit without generic confirmation,
  inventory modification or AP spending, then repeat only the consented safe
  cycle on the corrected candidate. Confirm per-task outcomes, actual game
  home, explicit Stop state and control ownership; a `next_time` update alone
  is insufficient. Do not resume old default/premium-enabled task profiles
  without fresh permission.

Physical ARM devices, Android 15's historical failures, long unattended play and
screen-off behavior remain separate, unpassed acceptance scopes. Historical
benchmarks remain bound to their original source/APK hashes.

## Inventory-full candidate: observed cycle with unclaimed rewards

This appendix describes the subsequent inventory guard and its local tests.
It does not replace the rejected/incomplete results above or attribute new
behavior to the `440fbb0f` APK. The new APK completed the seven-entry scheduler
cycle, returned to the actual game home and was explicitly stopped, including
a verified inventory-full skip. This is not a claim that every reward was
collected or every business action was performed.

### Strict policy and result semantics

- The Android native-capture guard is limited to the CN 1280 x 720 layout with
  the reference input ratio equal to one. Cached pixels are only a probe:
  two fresh captures must match the complete inventory notice, including title,
  both message lines and button label, with raw character confidence at least
  0.8. Unknown text, OCR/capture failure or a changed ratio authorizes no click.
- Only that fully verified notice may be dismissed, using its X at reference
  coordinate `(910, 138)` once. No generic confirmation, inventory organization,
  AP spending or purchase is permitted. Two further valid, nonblank/nonuniform
  1280 x 720 captures must establish that the notice disappeared; an uncertain
  close cannot authorize continuation or a second X attempt.
- Only `mail`, `collect_daily_power` and `collect_reward`, while the script is
  still running and the close was verified, may continue scheduling with a
  warning explicitly stating `SKIPPED` and rewards `unclaimed`. This is not a
  successful reward claim, even if its next schedule time advances. Other
  activities or unknown ownership stop safely after a verified X close;
  unknown notices stop without a click, and uncertain closes stop without
  retrying X or automatically restarting.
- Guards run before generic popup/loading handling, inside the loading loop
  and after a successful return from each of the three claim tasks. An existing
  task failure is not converted into a skip. Dedicated exception handling
  precedes the retry/restart path and also covers the final return-home path
  outside an individual task. The eight-second logical recognition deadline
  is soft; capture/click RPCs retain their separate underlying timeout bounds.

### Local verification, not a device result

- The full Android Python adapter suite ran 93 tests: 92 passed and one skipped,
  using a `uv`-managed Python 3.11 environment with `opencv-python-headless`,
  NumPy and Pillow. Tests include strict notice matching, fresh-frame and ratio
  checks, uncertain closes, unclaimed skip/stop distinctions, loading-loop
  interception and the outer scheduler exception path.
- A separate regression with the existing Python 3.9 interpreter, matching the
  Android Python language version, passed all 42 inventory, bootstrap-preserve
  and home-assets tests with no skips. This is a targeted subset in a different
  environment, not an additional full-suite run; no new dependencies or source
  changes were needed for it.
- An additional full-suite attempt under Python 3.9 did **not** pass: one ACL
  test-harness import requires `tomllib`, which is only in the standard library
  from Python 3.11. The passing 42-test subset must not be described as a passing
  Python 3.9 full suite. The full 93-test result above belongs to Python 3.11.
- Frontend re-verification passed 271 tests / 7,604 assertions and TypeScript
  checking.
- The first full-suite attempt with the system Python 3.14 environment did
  **not** pass: it lacked `cv2`, and the existing bootstrap fingerprint
  serializer did not support a `slice` object in that interpreter's
  `co_consts`. The successful Python 3.11 run must not be reported as a passing
  Python 3.14 run or as device acceptance.

### Candidate identity, installation and device cycle

The rebuilt debug APK is 110,542,719 bytes, SHA-256
`9a90bdd70eef0cf45e73877697f56e7039a56c76faa7d0763fd89495dfe9d6f8`.
In-place installation with `adb install -r -t` succeeded, and the installed
`base.apk` hash matched that exact artifact.

- Both original user profiles' configuration and event documents were compared
  item by item as JSON with their pre-installation snapshots and remained
  identical. A separate owned validation copy was created rather than resetting
  either original profile or importing the obsolete archive.
- The actual validation copy passed the safety checks: exactly seven consented
  entries enabled and due, all four ticket-purchase counts and both shop-refresh
  counts zero, all shop selections zero, invitations/exchanges and acceleration
  off, and empty pre/post lists. `autostart` was false.
- The installed private `Baas_thread.py` contained the new task and outer
  round-end inventory markers/catches and the post-claim result check. Shizuku
  remained running and granted under UID 2000; the shared service was not
  restarted for this installation or attempt.
- The visible Start control was used at **2026-10-23 22:00:03 local time**
  (Asia/Shanghai). Its owned display rendered the real game's loading view,
  and the observer recorded all seven scheduled entries. The completion marker
  appeared at 22:04:12.034; the per-task outcomes below determine what was
  actually claimed, skipped or merely visited.

The local package audit matched all 183 frontend files, 12 native libraries,
the linked Rust output, both fullscreen/resume command ACLs and the generated
Python archive. The packaged inventory/bootstrap bytecode matched the frozen
source, including task, loading-loop and outer round-end guards. ZIP CRC and
APK v2 signature verification passed. These checks bind the device observations
to the candidate; they are not substitutes for them.

| Scheduled entry       | New-candidate observed outcome                                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cafe_reward`         | Earnings were attempted, with a `reward_acquired` stage followed by a capacity notice; four interaction rounds ran. Full earnings collection is not established. |
| `lesson`              | Zero tickets; skipped without buying replacement tickets. No new lesson was performed.                                                                           |
| `group`               | Club page reached; no evidence of an additional sign-in reward.                                                                                                  |
| `mail`                | Strict two-frame notice recognition and X-only close, followed by `WARNING SKIPPED/unclaimed`; not a successful mailbox claim.                                   |
| `collect_daily_power` | A claim attempt reached `reward_acquired`, then `claim all grey`. This does not establish an AP reward was received.                                             |
| `rewarded_task`       | `INADEQUATE TICKET`; status remained `[False, False, False]`. No bounty sweep was performed and no tickets were purchased.                                       |
| `collect_reward`      | Claim controls were grey; no additional reward acquisition was observed.                                                                                         |

For mail, the verified-notice/X-only log was at 22:03:29.610 and the explicit
`SKIPPED/unclaimed` warning at 22:03:30.435, an interval of 0.825 seconds. The
strict inventory boundary therefore continued scheduling without claiming
success, organizing inventory, spending AP or pressing generic confirmation.
The complete observer record and a fresh 22:04:56 state snapshot were retained
privately. Resource OCR timestamps had advanced to 22:04:18; the actual game
home and matching UI resource cards were visually confirmed. Fresh premium
currency OCR matched its pre-run reading, AP remained full, and no paid
confirmation appeared in the observed logs. Balances are not publication data.

The visible Stop control was used at **22:05:06.983**. The fresh 22:05:07 backend
state was `running=false`, `is_flag_run=false`, `current_task=null`, an empty
queue and `exit_code=null`. These observations establish a completed scheduler
pass and explicit stop with the outcomes above, not universal reward success.

A separate native-fullscreen check on this candidate kept the same game
process and owned display while entering fullscreen, dragging/opening the
floating menu and returning to portrait. Harmless automation shell `true`
was rejected during manual control and after returning; the script did not
restart automatically. A second native-fullscreen entry followed by the
floating menu's Close Game action restored portrait orientation, removed the
owned display (`shizukuDisplayId=-1`) and left no game process. No failure toast
was observed. The monitor recorded two fullscreen entries and two exits.

Both owned daily-validation profiles, including the earlier failed attempt and
the inventory-corrected copy, were backed up to a private configuration archive
and then deleted through individually confirmed UI actions. Only the original
two user profiles remained; their configuration and event JSON documents were
deep-equal to the pre-installation snapshots, and the original daily profile
was selected again. Every backend status was idle/not running, no owned game
display remained, and shared Shizuku was still running/granted under UID 2000.
No task-created temporary ADB forwarding remained; the three temporary UI XML
files were also precisely cleaned up. Private backups and raw evidence were
retained, not published or bundled into the app.

This round logged 15 tentative fallback taps, and initial game-home recognition
took approximately 79.5 seconds. It must not be described as smooth startup or
flawless image recognition. The final, closed monitor session for this candidate
contained 5,753 valid samples, with a maximum event-loop gap of 432 ms, no gap
above 500 ms and no reported browser long task. This applies only to that
observation window, separately from the earlier `440fbb0f` session, not to
long-term usage.

The earlier inventory-blocked round remains incomplete; it does not inherit
this candidate's later scheduler completion. Physical ARM devices, Android 15,
screen-off behavior and long unattended operation remain outside the passed
scope.

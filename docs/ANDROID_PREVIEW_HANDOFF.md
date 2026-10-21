# Android Preview Handoff

Updated: 2026-10-21. Android runtime work is on hold. The changes on
`fix/android-trusted-display-and-insets` are not accepted for release and must
not be merged into `android-dev` or `dev` as a completed preview fix.

## Baseline

- Parent: `android-dev` at `5ca0ac7ca88ec8523d17bfbd9aca0750d8ba7d78`.
- Last tested implementation: `36f08fd35535dccf80b4c51c56da8d33b4201823`.
- Test build: x86_64 debug, application ID
  `io.github.kiramei.baas_tauri.docs.x86`.
- Installed APK SHA-256:
  `b1324e14ffda8e5a4a92f726232fdf29f8af7b5021f85f0f1cb8e09097dde321`.
- Environment: MuMu, Android 15 / API 35, shell-mode Shizuku (UID 2000),
  720 x 1280 primary display at density 240. This is an emulator result,
  not validation on the phone model reported by its system properties.
- The virtual display is 1280 x 720. No Root is required by the shell path.
  This emulator denies `ADD_TRUSTED_DISPLAY` to shell, so it uses the
  untrusted-display fallback.

The APK hash identifies a locally tested build, not a downloadable release.
Builds must include current frontend assets, embedded Rust and native libraries;
recompiling Kotlin alone can leave the frontend or native implementation stale.

## Changes Kept On This Branch

| Commit | Change |
| --- | --- |
| `8e38508f` | Wait for display registration before configuring rotation. |
| `532f785b` | Require capture, EGL submission and TextureView consumer progress for the live indicator. |
| `79d0d6f4` | Include the installed APK path in the owned Shizuku user-service version, avoiding stale JNI code after reinstall. |
| `128983b8` | Count distinct positive SurfaceTexture timestamps instead of redraw callbacks. |
| `36f08fd3` | Restore a white foreground for the destructive stop control. |

The branch also contains the earlier isolated system-bar inset, task-transfer,
native-preview and privileged-execution work. Review the complete diff against
the parent above before transplanting any subset.

## Verified Boundaries

- The system-bar inset change keeps the WebView clear of status/navigation bars;
  native preview positioning uses the resulting WebView offset.
- The stop icon was checked in the installed build. The frontend suite passed
  230 tests / 7,486 assertions, with 24 stop and six start browser states checked.
- The native unit suite last passed 39 tests: rotation four, task transfer nine,
  preview progress twelve and privileged execution fourteen.
- The account-free fixture can produce continuously changing frames and accept
  click, swipe and press through the embedded local adapter in shell mode.
- The documentation benchmark has 400 screenshot and 216 input samples plus
  86 warmups, with configuration/event/UI restoration checked. It measures
  those adapter/script calls, not game FPS or general phone performance.

The benchmark source, fixture, sanitized samples and limitations are on
`docs/dev-refresh`, under `docs/benchmarks/`, `docs/scripts/measure-android-local*`
and `docs/public/benchmarks/android-local-current.json`. Preserve the original
source/APK hashes when using those historical results.

## Open Failures

1. Real game startup still has blackouts and stalls. A historical 111.617-second
   observation contained an observed 6.969-second interval without consumer
   counter growth. Later progress does not establish a resolved startup defect
   or successful unattended automation.
2. SDK activities can appear on display 0 after the launcher activity starts on
   the virtual display. Android logs reject several subsequent game activities
   on the untrusted display. The 500 ms reconciliation loop moves displaced
   root tasks back; this is recovery after displacement, not prevention.
3. One earlier emulator system-server crash involved
   `TaskUtils.shouldIgnoreDesktopHomeOcclusion`, followed by a game
   `DeadSystemException`. The trigger has not been isolated. Do not attribute
   that crash to a specific fix, game behavior or Root requirement.
4. Long-running gameplay, screen-off behavior, app switching and physical-device
   compatibility have not passed acceptance. No account-spending or business
   automation test is implied by fixture success.

## Code Map

Paths below are relative to `src-tauri/gen/android/app/src/main/`:

- `java/io/github/kiramei/baas_tauri/ShizukuShellService.kt`: display creation,
  fallback flags, launch, placement monitoring and input/capture ownership.
- `java/io/github/kiramei/baas_tauri/GameTaskTransfer.kt`: root-task enumeration,
  reparenting and focus checks.
- `java/io/github/kiramei/baas_tauri/NativeGamePreview.kt`: TextureView surface
  ownership, native controls and focus recovery.
- `java/io/github/kiramei/baas_tauri/PreviewFrameProgress.kt`: three-stage progress
  classification. Counters do not measure unique pixels or screen refresh FPS.
- `java/io/github/kiramei/baas_tauri/MainActivity.kt`: system insets and preview
  lifecycle. `onPause` currently disconnects the preview. Whether this causes
  visible-but-unfocused freezes remains an untested hypothesis.
- `cpp/display_capture.cpp`: AImageReader acquisition, CPU screenshot copies,
  EGL rendering and retained-image handling.
- `java/io/github/kiramei/baas_tauri/BackendServicePlugin.kt`: native bridge and
  preview diagnostics.
- `java/io/github/kiramei/baas_tauri/BaasLocalDeviceServer.kt` and
  `python/android_backend/native_device.py`: authenticated loopback adapter.

The frontend placeholder is `src/components/AndroidVirtualDisplayPreview.tsx`.
Rust commands are in `src-tauri/src/mobile_commands.rs`.

## Suggested Investigation

1. Use the account-free fixture first. Record capture, successful EGL swaps,
   distinct consumer timestamps, activity visibility/focus and the actual
   displayed fixture counter on the same monotonic timeline. Capture progress
   alone cannot establish that the user sees motion.
2. Reproduce an individual startup failure before changing display flags or
   lifecycle policy. Keep task/display transitions and relevant WindowManager
   errors alongside the counters. Test one change at a time.
3. Compare with [MAA-Meow](https://github.com/Aliothmoon/MAA-Meow) at
   `aa9193f9a11eb1f1cfa71ed5fb917487cb94f3de`, specifically
   `remote/internal/VirtualDisplayManager.kt`, `FrameCaptureHelper.kt` and
   preview-surface handover. Its fallback and presentation-flag choices are
   useful comparison points, not proof of the cause here. Check its license
   before reusing code.
4. Test visible-but-unfocused preview separately from fully hidden activity
   behavior. Android documents the distinction in its
   [activity lifecycle guidance](https://developer.android.com/guide/components/activities/activity-lifecycle).
5. Repeat native and frontend tests, rebuild all APK components, verify the
   installed APK hash, then repeat fixture and consented game checks. Keep
   historical benchmark records bound to their original implementation.

## Safe Resumption And Evidence

- Inspect active tasks, game/fixture processes and display ownership before
  touching the device. Do not interrupt another user's current session.
- Preserve configuration, events, UI preferences and scheduler state. Stop only
  sessions created by the test and verify restoration, including failure paths.
- Do not enable Root, restart the emulator or restart the shared Shizuku service
  without fresh permission. A previous one-time Shizuku restart was already used.
- Game-account operations, rewards, resource spending and business-task execution
  require separate approval. Fixture results do not authorize those actions.
- Raw device logs, original screenshots/videos, tokens, private configuration and
  machine-specific paths are intentionally absent from this handoff. They must
  stay outside Git and the published site. Existing private diagnostics live in
  ignored `.cache/android-native-fix/` and `.cache/android-local-benchmark/`
  directories of the documentation worktree; these are optional local evidence,
  not portable dependencies.
- Public game media has baked-in local Gaussian blur. New media needs its own
  privacy review; do not publish raw captures or merely obscure them with CSS.

At the last read-only check, the test app was running, game and fixture processes
were stopped, and the shared Shizuku/system processes had not changed. Recheck
these conditions when resuming; process IDs and device connection details are
deliberately omitted.

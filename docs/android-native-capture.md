# Android native capture and preview

The on-device game preview does not use H.264, HTTP video, WebCodecs, or canvas.
The virtual display always targets the NDK ImageReader's Surface:

```text
VirtualDisplay → AImageReader → AImage / AHardwareBuffer
  ├─ EGL external texture → native TextureView embedded over the DOM placeholder
  └─ RGBA triple buffer → on-demand PNG → authenticated local automation adapter
```

The preview is a native TextureView rather than MAA-Meow's SurfaceView so that it
can be clipped, rounded and positioned within the Tauri WebView layout. Its
controls are native too, with actions dispatched to the existing page handlers.
The page sends layout/visibility updates and polls counters, not image data.
Closing/hiding the preview disconnects its Surface without stopping capture.

The renderer keeps at most one pending image, dropping superseded frames. It
retains each AImage until GPU sampling finishes. Screenshot readers retain their
triple-buffer slot; capture never overwrites a published or borrowed slot.
RGBA copying is still required for CPU automation. PNG encoding occurs only on
an automation screenshot request, not for preview frames. This is not an
end-to-end zero-copy screenshot pipeline.

Shell-backed Shizuku owns capture directly. Root-backed Shizuku retains the
existing system-identity display process. That process publishes a restricted
Binder endpoint through NativeDisplayProvider; only system/root may publish,
and the endpoint accepts only the installed application's UID. Surface handles
cross Binder; pixels do not. Process death invalidates the endpoint.
When the UI process restarts, it requests re-publication through the privileged
service, preserving the existing virtual display and game session.

Touch gestures use cached InputManager reflection with the target display ID.
DOWN waits for completion; MOVE/UP are asynchronous. Failure after DOWN attempts
CANCEL to avoid leaving a finger held down. No per-gesture `input` process is
started. Some non-touch compatibility commands still use shell commands.

Embedded automation selects `android_local` consistently, including when the
legacy display-ID file exists. The adapter calls the authenticated local bridge
directly, without ADB, accessibility, or a UIAutomator server for capture/touch.
Frame counters are exposed in authenticated `/info` for verification.

Native capture requires Android 8 / API 26. The application minSdk remains 24;
older devices receive an explicit unsupported-capture error. Newer native APIs
are weak-linked, and Kotlin checks the SDK before loading the capture library.

Architecture reference reviewed: MAA-Meow commit
`f79422a5d5f9e0d2f91585a8d57ae7819704eea6`. This implementation is independently
written; it does not replace this project's Python runtime with MAA Core.

## Device validation

Validated on the connected Android device in root-backed Shizuku mode:

- The native embedded view visibly shows the game and its presented-frame count
  increases alongside captured frames.
- Tapping the view opens the native controls; tapping outside the buttons hides them.
- Force-stopping and reopening the app restores the native preview, with the
  same virtual display ID and continuing frame counters; the game is not relaunched.
- The scheduler reports `Initialization Finished`, enters a task, reads game
  screenshots and sends touch events. It was manually stopped after this smoke test;
  completion of individual gameplay tasks is not claimed.
- TypeScript checking, APK assembly and the five Android adapter/bootstrap tests pass.

Shell-backed Shizuku is implemented but has not been device-tested in this run.
No glass-to-glass latency measurement has been made; the native rendering path
removes video encoding/decoding, but Python screenshots still pay PNG/RPC costs.

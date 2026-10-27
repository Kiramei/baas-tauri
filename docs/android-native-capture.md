# Android native capture and preview

This page describes the native display data path. Current implementation and
acceptance boundaries are recorded in [goals and current status](ANDROID_GOALS_AND_STATUS_20261024.md),
[version-specific runtime validation](ANDROID_RUNTIME_VALIDATION.md), and the
[historical preview handoff](ANDROID_PREVIEW_HANDOFF.md). Results belong to the
documented APK and device; they do not establish release or general compatibility.

## Display and screenshot data paths

The on-device preview uses a native TextureView, rather than an H.264 stream
decoded in the WebView. The owned VirtualDisplay targets an NDK ImageReader:

```text
VirtualDisplay → AImageReader → AImage / AHardwareBuffer
  ├─ EGL external texture → native embedded / fullscreen TextureView
  └─ RGBA triple buffer → on-demand PNG → authenticated local automation adapter
```

The page sends layout, visibility, theme and control updates; it does not receive
the preview's image data. Fullscreen is a presentation change for the same owned
display, rather than a game restart or transfer to the primary display. Hiding
the embedded preview disconnects its Surface without stopping capture.

The renderer retains an AImage until GPU sampling finishes and drops superseded
pending images. Screenshot readers retain their triple-buffer slot; capture
does not overwrite a published or borrowed slot. CPU copying and black-frame
inspection run outside the shared preview publication lock. Capture shutdown
rejects new publication and drains in-flight callbacks before destroying the
reader.

Automation still requires RGBA copying, on-demand PNG encoding, Base64, local
RPC and Python decoding. This is not an end-to-end zero-copy screenshot pipeline,
and these architecture changes alone do not demonstrate a performance gain.

## Privileged ownership and input

Shell-backed Shizuku owns capture directly. Root-backed Shizuku uses a
system-identity display process and an app-scoped Binder endpoint. Re-publication
and Activity-session binding preserve ownership across UI recreation; stale UI
owners must not control a new session.

The Python `android_local` adapter uses the authenticated local bridge for
capture and touch, without ADB, Accessibility or a UIAutomator server in that
ordinary automation path. Native manual controls and automation target the
same owned display with lease, generation and focus checks. Automation has
priority over a competing manual gesture and cancels or rejects it as needed;
entering manual presentation does not itself stop scheduling. Unverified input
targets are rejected rather than falling back to primary-display injection.

Native capture requires Android 8 / API 26; the application's minSdk remains 24.
Older devices receive an explicit unsupported-capture error. Newer native APIs
are weak-linked and loading is guarded by SDK checks.

## Validation scope

The latest documented Android 12 ARM64 physical-device debug candidate, using
root Shizuku, has scoped startup, preview entry/return, Activity recreation and
configuration ZIP results. Android 15 shell-mode input, the full gesture matrix,
release acceptance, long unattended operation and overall performance gains
remain unverified. See the linked status records for exact candidate identities,
historical failures and outstanding checks.

Architecture reference reviewed: MAA-Meow commit
`f79422a5d5f9e0d2f91585a8d57ae7819704eea6`. This implementation is independently
written and does not replace this project's Python runtime with MAA Core.

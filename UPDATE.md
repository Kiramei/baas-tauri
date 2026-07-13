## v0.0.7

> This release introduces the native Android client and a recoverable transport architecture, while improving frontend responsiveness, diagnostics, updater visibility, and runtime stability since v0.0.6.

### New Features

1. **Native Android client**
   Added Android packaging with a bundled Python backend, mobile configuration and settings views, accessibility automation integration, foreground service controls, notification-based script toggles, Android updater support, and a signed arm64 APK release workflow.

2. **Recoverable service transports**
   Added selectable frontend transports, native named pipe support for desktop clients, automatic recovery after backend disconnects, and transport lifecycle events shared across WebSocket and pipe connections.

3. **System diagnostics and notifications**
   Added frontend system log collection and settings, script lifecycle notifications, service status notifications, inline terminal output, and richer updater workflow status visualization.

### Improvements

1. **Frontend architecture and responsiveness**
   Reduced unnecessary rendering, preserved unsaved configuration drafts, improved page activity handling, and polished responsive configuration, Wiki, scheduler, home, setup, and settings views.

2. **Android runtime and development workflow**
   Added hot development tooling, CSS compatibility processing, backend synchronization, startup handoff, UIAutomator bridging, runtime installation, backend restart handling, and Android-specific build validation.

3. **Updater and terminal behavior**
   Improved Android update progress and logs, made failed SHA probes noninteractive, preserved provider and WebSocket log scopes, and stabilized updater terminal snapshots and embedded Wiki rendering.

4. **Release and quality automation**
   Added signed Android APK publishing, transport build checks, frontend transport tests, broader quality workflows, and default-branch corrections for release automation and dependency updates.

### Fixes

1. Fixed Android startup rendering, backend reconnect and restart behavior, app relaunch after updates, configuration encoding, Wiki rendering, icon alignment, and local automation integration.
2. Fixed desktop startup blank frames, Tauri development startup, schedule configuration black screens, and configuration draft loss.
3. Fixed blocking SHA source tests and incomplete locale translations.
4. Fixed script notification snapshots, updater terminal embedding, service log scopes, and transport recovery edge cases.

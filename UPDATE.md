## 0.0.9.post1

> Stable maintenance release focused on Android first-run setup, plugin execution, and release version handling.

### Improvements

1. Added Android first-run update channel selection and more resilient backend installation, with clearer installation progress and startup logs.
2. Improved profile initialization, configuration navigation, plugin settings, and localization across the client.
3. Standardized public release versions and native package version ordering across Android, Windows, macOS, and updater feeds.

### Fixes

1. Restored Android first-run installation and native plugin execution, including backend download and Git installation recovery.
2. Improved Android backend lifecycle handling, profile templates, and startup diagnostics.
3. Added regression coverage for installation, version ordering, release workflows, and profile initialization.

### Upgrade Notes

- This is a stable post release. Back up important profiles before upgrading.
- Android retains the existing release signing identity.
- Winget publication is skipped for 0.x releases.

## v0.0.9

> Stable release with cross-platform plugins, authenticated WebUI operations, backend and client history, expanded configuration coverage, native desktop transports, and a substantially upgraded Android client.

### New Features

1. **Cross-platform plugin workspace**
   Added a shared plugin manager for desktop, Android, and WebUI with declarative interfaces, trusted external ZIP installation, per-profile enablement and settings, disposable Android worker processes, and five built-in tools: AP hoarding, automatic stage progression, equipment planning, the inventory search-board calculator, and Home editing.

2. **Authenticated WebUI operation**
   Added browser login, authenticated Key reset, hardened Docker startup, and consistent client terminology. Resetting the Key invalidates existing browser sessions while preserving profiles.

3. **Release and backend history**
   Added backend commit history across desktop, Android, and WebUI, plus client release history in Help. The bundled history is refreshed during release builds.

4. **Expanded gameplay and notification settings**
   Added Arena rank-1 stopping, simple-mode stage exploration and story episodes, Cafe interaction delay, and Feishu, WeCom, and Telegram notification options. Controls remain disabled when the connected backend does not expose the corresponding field.

5. **Native platform capabilities**
   Added Windows desktop capture and control defaults for new PC profiles, macOS shared-memory transport, Linux native window controls, and corrected Linux rendering. Existing WebSocket and named-pipe transports remain available.

6. **Android runtime and manual control**
   Added same-session native fullscreen manual control, automation-priority input, native TextureView preview with shared virtual-display capture, virtual-display lifecycle recovery, compute-plugin workers, clearer run/update controls, and mobile navigation and configuration coverage.

### Improvements

1. Refined desktop and Android configuration, scheduling, settings, profile navigation, update history, logs, and responsive layouts.
2. Improved updater safety with streamed UV output, idle backend updates, scheduler state recovery, stale-mirror rejection, CNB source support, and removal of the obsolete `baas-cdn` source.
3. Expanded bilingual user and API documentation, repaired portable search indexing, replaced showcase media with reviewed dark WebP images, and removed obsolete process reports while retaining reusable validation fixtures.
4. Added broader frontend, browser, native transport, Android worker, documentation export, and cross-platform build coverage.

### Fixes

1. Fixed Linux focus, native IPC, rendering, and window chrome behavior, and added macOS shared-memory compatibility.
2. Fixed Android startup and backend lifecycle races, virtual-display focus and orientation, short-tap input, OCR ABI selection, preview buffer accounting, system-bar layout, and upgrade-time service replacement.
3. Fixed WebUI authentication recovery, Docker runtime handling, backend Key reset, and login terminology.
4. Fixed desktop scheduler, configuration, settings, transport recovery, profile initialization, and localization regressions.
5. Removed stale CDN update paths from desktop, Android, WebUI, and Docker flows.

### Upgrade Notes

- Export important profiles before upgrading.
- Plugins and newly added script fields require a compatible backend; unavailable fields remain disabled on older backends.
- External plugin ZIPs execute code and require explicit trust for each profile.
- Android support varies by device and automation task; consult the Android guide for the current validation boundaries.
- Pull the new WebUI Docker image to update both the interface and its runtime dependencies.
- Android continues using the existing release signing identity.
- This is a stable release: updater manifests, stable Docker images, CNB release synchronization, and Winget submission are enabled after successful artifact publication.

## v0.0.8-rc

> Release candidate for changes since v0.0.7, focused on editable scheduling, configuration coverage, resilient downloads, and startup/UI stability.

### New Features

1. **Editable scheduler workflow**
   Added a graph editor alongside the existing task list, with separate prerequisite and post-task connections, cycle validation, task enable/time controls, search, zoom, minimap, automatic layout, and per-backend/account layout persistence. The graph edits existing scheduler data; it is not a separate execution engine.

2. **Minimize to tray**
   Added a persisted desktop preference and tray show/hide/toggle/exit actions. Normal window behavior remains available if tray initialization fails.

3. **Expanded gameplay configuration**
   Added unrestricted decisive battle formation settings, including copying a cleared formation and its unavailable-student/refresh limits. Friend cleanup now supports level, inactivity, and last total-assault rank filters alongside the existing whitelist.

4. **Windows shared-memory transport**
   Added a bounded, ordered shared-memory adapter for local task updates, logs, and remote display. Existing WebSocket and named-pipe modes remain available. Shared memory requires a backend that supports `--shm-name`; startup checks report an incompatible backend explicitly.

5. **Desktop navigation and appearance**
   Added a custom title bar with back/forward navigation, an expandable profile drawer, consistent menus and tooltips, a permanent About entry, and responsive task and log layouts. Original UI fonts, monospace logs, cursor shapes, and the color application logo are preserved.

### Improvements

1. **Multi-source download recovery**
   Unified source failover and persisted source selection across repository and runtime downloads, including Android updater paths, to recover from unavailable mirrors.

2. **Faster backend startup**
   Reduced WebSocket and native pipe readiness delays and improved backend connection handoff.

3. **Documentation and maintenance**
   Expanded Android guidance, release history, and migrated gameplay documentation. Consolidated GitHub workflows, updated default-branch references to main, and simplified updater orchestration and unused dependencies.

### Fixes

1. Kept loading indicators active and configuration cards visible in low-performance mode.
2. Preserved the log viewer across page switches and reduced log scrolling jitter.
3. Preserved array types and immutable snapshots when applying scheduler resource patches, without dropping unrelated task fields.
4. Extended localization and regression coverage for the new configuration and scheduler controls.
5. Displayed five bounty regions for JP profiles and three for CN/Global profiles. Existing JP counts retain their values and gain two zero-valued draft entries; saving continues to use the backend's CSV format.
6. Removed the obsolete detached Wiki window, duplicate display and installer code, and development-only frame diagnostics. Documentation links now open in the system browser.

### Release Notes

- This is a prerelease for validation, not the stable 0.0.8 release.
- Includes Windows, macOS, Linux, Android arm64 APK, and WebUI Docker builds.
- Android continues using the existing release signing identity.
- Gameplay options require a backend that implements the corresponding configuration fields.
- Existing scheduler task data remains authoritative; graph layout is UI-only.
- Stable updater manifests and Winget publication remain disabled for this RC under the existing release policy.
- The WebUI Docker workflow validates the RC build without publishing registry images.

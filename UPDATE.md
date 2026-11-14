## 0.0.10

> Stable release focused on Android updates and game launch recovery, stable backend defaults, and local MirrorChyan credentials.

### New Features

1. Added Android client update downloads with signed APK verification and handoff to the system installer.
2. Added native MirrorChyan CDK verification and device-local credential storage for desktop and Android. Stable backend packages are checked against their SHA-256 before application.
3. Added an **Open on device** action for Android game sessions whose background preview is unavailable, with recovery of an existing foreground game task when possible.

### Improvements

1. New backend installations default to the stable channel across desktop, Android, WebUI/Docker and BAASX. Existing installations keep their saved channel, and development remains selectable.
2. Improved Android game package detection, virtual-display ownership and restart handling, including Global Teen and ONE store package variants.
3. Separated client frontend, native backend, operating-system adapters, BAASX and documentation verification so changes run the relevant CI jobs. README-only changes use lightweight documentation checks.
4. Prepared six-target BAASX distributions and platform-specific optional npm runtime packages. The scoped `@kiramei/baasx` entry remains the registry installation name; BAASX distribution publication uses its independent version and release tag.
5. Renamed the BAASX native helper to `baasx-runtime`, retaining the legacy executable, Cargo entry and environment-variable lookup for existing installations.

### Fixes

1. Avoided relaunching an already active Android game when the Home page reconnects, and coordinated game display cleanup before restart or foreground launch.
2. Corrected client update feed selection to advertise signed assets for the matching operating system, architecture and Linux package format.
3. Kept MirrorChyan credentials out of synchronized frontend configuration and sanitized credential-bearing download diagnostics.
4. Corrected cross-platform BAASX packaging, Windows archive handling, terminal input synchronization and runtime compatibility checks.
5. Synchronized native release versions and the legacy runtime dependency, and moved Renovate configuration to the repository root.

### Upgrade Notes

- Export important profiles before upgrading. Existing backend installations continue using their saved update channel.
- Android updates require confirmation in the system installer and may require allowing this application to install packages.
- Android game capture and background execution depend on the device's privileged-display support. **Open on device** provides a foreground recovery path when a background session cannot continue.
- Enter a personal MirrorChyan CDK on each device when using that source. Do not include credentials in screenshots or exported configuration.
- The unscoped npm name `baasx` is on hold while its registry naming appeal is pending. Use `@kiramei/baasx` for registry installations.
- Linux ARM64, Intel macOS and Windows ARM64 BAASX clients support remote connections and demo mode. Local OCR prebuilds currently cover Linux x64, Apple Silicon macOS and Windows x64.
- Winget publication remains disabled for 0.x releases.

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

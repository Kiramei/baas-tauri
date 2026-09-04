## v0.0.8-rc

> Release candidate for changes since v0.0.7, focused on editable scheduling, configuration coverage, resilient downloads, and startup/UI stability.

### New Features

1. **Editable scheduler workflow**
   Added a graph editor alongside the existing task list, with separate prerequisite and post-task connections, cycle validation, task enable/time controls, search, zoom, minimap, automatic layout, and per-backend/account layout persistence. The graph edits existing scheduler data; it is not a separate execution engine.

2. **Minimize to tray**
   Added a persisted desktop preference and tray show/hide/toggle/exit actions. Normal window behavior remains available if tray initialization fails.

3. **Expanded gameplay configuration**
   Added unrestricted decisive battle formation settings, including copying a cleared formation and its unavailable-student/refresh limits. Friend cleanup now supports level, inactivity, and last total-assault rank filters alongside the existing whitelist.

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

### Release Notes

- This is a prerelease for validation, not the stable 0.0.8 release.
- Includes Windows, macOS, Linux, Android arm64 APK, and WebUI Docker builds.
- Android continues using the existing release signing identity.
- Gameplay options require a backend that implements the corresponding configuration fields.
- Existing scheduler task data remains authoritative; graph layout is UI-only.
- Stable updater manifests and Winget publication remain disabled for this RC under the existing release policy.
- The WebUI Docker workflow validates the RC build without publishing registry images.

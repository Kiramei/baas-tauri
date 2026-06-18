## v0.0.3

> This is a test version.

### New Features

1. **Keyboard shortcut support**
   Added a home-page shortcut settings panel and Tauri global shortcut integration for common profile actions.

2. **Client self-update status**
   Added Tauri client update information to the version panel, including local version, latest version, update status,
   download progress, and install/relaunch flow.

3. **Normal context menu**
   Added a right-click menu for common page areas with reload, copy, paste, and inspect actions. Tauri release builds
   can open WebView devtools, while WebUI prompts users to open browser devtools with F12.

4. **Configuration import/export UI**
   Added UI support for importing and exporting profile configuration data.

5. **More emulator support**
   Expanded supported emulator options in the configuration UI.

6. **Docker/WebUI deployment**
   Added Docker build assets and release workflow support for the WebUI image.

### Improvements

1. **Workflow and terminal execution**
   Added reusable workflow task support in `baas-term`, including chained process commands, detached process support,
   captured output for detached processes, and unlimited running-region output where needed.

2. **Release automation**
   Refactored duplicated GitHub Actions steps into reusable composite actions, improved release channel handling, added
   Docker/CNB publishing support, and added Renovate configuration.

3. **Font pipeline**
   Switched the primary font to Blueaka, changed Korean fallback to GmarketSans, and kept Rubik as the Russian fallback.

4. **Version checks**
   Backend update checks and Tauri client update checks now run every 1 minute in the background.

5. **Logger stability**
   Optimized the Home logger auto-scroll behavior to avoid visual jitter while logs are streaming.

6. **Remote player build**
   Fixed frontend player build warnings and improved WebGL utility compatibility.

### Fixes

1. Fixed BAAS update check interval behavior.
2. Fixed logger display and auto-scroll stability.
3. Fixed frontend player build warnings.
4. Fixed task output rendering limits for long-running backend launch tasks.
5. Fixed detached backend launch support in `baas-term` process tasks.
6. Fixed release workflow compatibility for Linux ARM and channel-specific publishing.
7. Fixed CNB sync so it only runs for the intended repository/branch.


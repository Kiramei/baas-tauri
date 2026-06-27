## v0.0.6

> This release focuses on documentation rebuilds, appearance customization, Windows release packaging, and wiki/install polish since v0.0.5.

### New Features

1. **Rebuilt documentation site**
   Added the new multilingual documentation site with feature guides, install guides, reference pages, screenshots, release download panels, and generated font subsets.

2. **Appearance customization**
   Added image background and color customization support, including the global appearance effect layer and color picker controls.

3. **Portable Windows release**
   Enabled portable Windows artifacts in the release workflow.

### Improvements

1. **Wiki display**
   Improved the in-app wiki viewer, local wiki content rendering, docs navigation, home layout, top logo display, and scrollbar styling.

2. **Installer configuration resolution**
   Improved Tauri install config path resolution and setup storage handling.

3. **Docs and README quality**
   Reformatted and polished README content, docs pages, feature descriptions, setup.toml references, and install instructions in English and Chinese.

4. **Release and docs CI**
   Updated release/docs workflows, removed the dev-triggered docs deployment path, and installed docs font subset tooling in CI.

5. **UI copy and comments**
   Normalized Chinese comments to English and shortened log level names for denser terminal display.

### Fixes

1. Fixed setup page i18n coverage.
2. Fixed incorrect install guide links.
3. Fixed Tauri install config resolution.
4. Fixed wiki display and docs source behavior.
5. Fixed selected link styling and related docs link presentation.
6. Fixed site styling and scrollbar polish regressions.

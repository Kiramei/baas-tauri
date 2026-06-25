## v0.0.5

> This release focuses on update-source reliability, lower-overhead UI behavior, terminal robustness, and configuration import ergonomics since v0.0.4.

### New Features

1. **Drag-to-add configuration**
   Added a config archive drop overlay so profile/config archives can be added by dragging them into the app.

2. **Git update mode selection**
   Added support for selecting Git update modes in setup/update configuration, including backend config plumbing and updater workflow integration.

3. **Low performance mode**
   Added a low performance UI mode that reduces visual cost across overlays, layout chrome, modals, progress UI, and animated text.

### Improvements

1. **Git source speed tests**
   Git2-based update sources are now included in speed/connectivity testing, so source selection reflects Git2 availability and performance.

2. **Terminal error handling**
   Improved terminal renderer error catching and line handling for updater/install workflows.

3. **WebUI overlay behavior**
   Unified switch behavior and reconnecting overlay handling for WebUI mode.

4. **Clipboard context menu**
   Reduced unnecessary clipboard permission/tip prompts when opening the normal context menu.

5. **Localization coverage**
   Added missing paste failure and drag-add configuration translations across supported locales.

### Fixes

1. Fixed Git2 crashes when no TLS backend is available.
2. Fixed missing Git2 speed-test coverage.
3. Fixed missing paste failure i18n entries.
4. Fixed clipboard tip alerts appearing during normal context menu usage.
5. Fixed terminal renderer error handling in updater logs.
6. Fixed WebUI reconnecting overlay behavior and switch component consistency.

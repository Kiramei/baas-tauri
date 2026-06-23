## v0.0.4

> This release focuses on installer stability, update controls, WebUI deployment behavior, and several setup/settings polish fixes since v0.0.3.

### New Features

1. **`no_update` setup option**
   Added `general.no_update` in `setup.toml`. When enabled, Tauri skips main repo, OCR repo, and client initialization updates; WebUI blocks OCR updates; Docker startup skips main repo update.

2. **Advanced setup control**
   The Tauri setup modal can now edit the `no_update` option together with the other advanced setup values.

3. **Expanded font subset generation**
   The font generation pipeline now tries to fetch BAAS `default_config.py` and includes its text in the generated font subset when available.

### Improvements

1. **macOS installer defaults**
   Fresh macOS installs now default to a `BAAS` directory next to the `.app` bundle instead of writing under the home directory.

2. **Installer error recovery**
   Setup errors now show clearer next-step guidance, keep logs scrollable, and provide an explicit return-to-setup action.

3. **Installer layout stability**
   The installer page now uses a constrained viewport layout with a scrollable main region to avoid footer/content overflow on smaller windows.

4. **macOS tray behavior**
   The tray icon is marked as a macOS template icon so the system can render it in the native menu bar style.

5. **Reload behavior**
   App-triggered reloads no longer show the Windows WebView "reload site" confirmation prompt while normal accidental reload protection remains in place.

6. **Update source testing**
   SHA/update-source API tests now use a 10-second upper timeout and the settings copy now labels the selector as "Update Source" instead of "Action".

7. **Shop currency display**
   Tactical shop prices now show tactical coins instead of pyroxene, with updated localized currency names.

### Fixes

1. Fixed repository/client update paths so `no_update` consistently prevents update checks and sync work across Tauri, WebUI, and Docker flows.
2. Fixed setup error modals that could truncate logs or hide follow-up actions.
3. Fixed installer viewport overflow reported on macOS screenshots.
4. Fixed right-click reload opening an unnecessary confirmation prompt on Windows.
5. Fixed tactical challenge shop item prices displaying the wrong currency.
6. Fixed slow update-source tests keeping the settings page in a loading state indefinitely.

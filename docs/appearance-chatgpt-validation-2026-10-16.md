# ChatGPT desktop appearance alignment — 2026-10-16

## Reference and implementation

Reference: the locally installed ChatGPT desktop client (`OpenAI.Codex 26.1007.9446.0`). Native screen capture failed with `IGraphicsCaptureItemInterop.CreateForMonitor / 0x80070057` twice. The reference application's installed CSS was inspected read-only instead. No packaged reference CSS, proprietary font or other application asset was copied into BAAS.

The implementation uses BAAS components and the system font stack, matching the reference's surface colors, typography scale, spacing and navigation proportions. This is not a claim of a screenshot-based pixel comparison.

| Property | Light | Dark |
| --- | --- | --- |
| Main surface | `#ffffff` | `#181818` |
| Sidebar | `#f9f9f9` | `#000000` |
| Foreground | `#1a1c1f` | `#dfdfdf` |
| Muted foreground | `#6a6b6d` | `#999999` |
| Secondary surface | `#f3f3f3` | `#282828` |
| Border | foreground at 8% | foreground at 8% |

- System font: Segoe UI, with Microsoft YaHei UI Chinese fallback; body 14px, root 16px.
- Custom Windows title bar: 44px; expanded sidebar 275px, collapsed 56px; navigation rows 32px.
- Neutral buttons, cards, inputs, menus, logs, loading/setup pages and workflow graph. Functional status colors remain distinguishable.
- Profiles are listed vertically in the desktop sidebar and horizontally on narrow windows. Existing profile management and drag ordering remain available.
- Other platforms with a native frame do not render the custom title bar. Windows fixed-WebView2 configurations also use the custom frame.
- Fullscreen and long configuration dialogs reserve title-bar space. Profile menus/dialogs are portaled outside the sidebar to avoid clipping.

## Native validation

All visual verification used a real Tauri window with the real Python backend and shared-memory transport. The test installation and settings are isolated under `<workspace>\.codex_tmp\appearance-validation`; the daily installation was not replaced. This appearance pass did not run game tasks or send game input.

Verified in the native development build:

- Computed font, colors and 44px/275px/56px measurements agree with the values above; `isDecorated()` is false.
- Light and dark Home/Settings, Scheduler, Configuration, profile menu and editor modal were inspected from actual WebView screenshots.
- Actual maximize button changes the viewport from 1280×800 to 2560×1392 and changes its label to Restore; Restore returns to 1280×800.
- Actual minimize button sets the native minimized state. Close retains existing native CloseRequested handling and hides the window to the tray.
- Sidebar collapse/expand changes its measured width from 275px to 56px and back.
- A real pointer drag reorders profile rows; a second drag restores their original order. The test settings retain their original profile order.
- 1280×800, 800×800 and 390×800 native sizes show no document horizontal overflow. Narrow layouts keep the profile strip and bottom navigation accessible.
- Profile editor opens outside the sidebar, respects the title bar, and was canceled without creating a profile.
- Fullscreen workflow heading begins at y=44 with height 52px; its Close button is within the viewport and passes a hit-target check. The graph was visually inspected after its palette update.

Reproducible inspection helpers:

```powershell
# Launch an isolated test instance with WebView2 loopback DevTools enabled first.
node scripts/appearance-validation.mjs 9230 snapshot
node scripts/appearance-validation.mjs 9230 screenshot D:\path\screenshot.png
```

`tests/browser/appearance-probe.ts` additionally exposes native resize and measurements in the Vite development build. Neither helper sends script or game commands.

## Checks

- Production Tauri build: i18n (579 keys), TypeScript, Vite, Rust release.
- Frontend suite: 51 tests passed, 703 assertions.
- Rust library suite: 21 tests passed.
- Rust Clippy: `-D warnings` passed.
- Changed UI components: ESLint passed. Browser appearance probe: standalone TypeScript check passed. Inspection CLI: Node syntax check passed.

## Final release verification

Final binary: `target/release/baas-tauri.exe`, 10,712,576 bytes.

SHA256: `B2A4D5F5064A219449F63FDDBB04F2DEBB1D79F9A10138E250634614D3156A1C`.

The same binary was copied to the isolated backend directory and tested with Vite stopped. The actual embedded page URL was `http://tauri.localhost/`, the backend showed Connected, and its task state was idle. Production checks passed:

- Light/dark screenshots and the measured 44px title bar, 275px/56px sidebar, 14px system font, neutral surface colors.
- Maximize 2560×1392, Restore 1280×800, sidebar collapse/expand.
- Native 390×640 minimum-height layout: document 390×640, profile modal x=16/y=171, width=358/height=342; title bar and all modal controls visible.
- Dark workflow graph uses the actual dark theme, surface `rgb(24,24,24)`; fullscreen heading y=44/height=52, Close is hit-testable.
- Native minimize and Close-to-tray behavior.

Release screenshots are under `<workspace>\.codex_tmp\appearance-validation`:

- `release-home-dark.png`, `release-home-light.png`
- `release-graph-dark.png`, `release-profile-390x640.png`

After inspection, the DevTools-enabled test instance was stopped and a normal release preview was launched without the remote-debugging argument. It uses the isolated backend and copied settings. The preview executable is `<workspace>\.codex_tmp\appearance-validation\backend\baas-tauri.exe`.

# macOS icons

`app-icon.png` is the editable full-resolution source. `icon.icns` contains the
16–1024 px application icon representations and is selected only by
`tauri.macos.conf.json`. Other platforms retain their existing icon assets.

The app icon was edited from `../icon.png` using the built-in image generation
tool. Prompt: preserve the original teal overlapping rectangle glyph and its
openings; replace the background with a near-white porcelain macOS rounded
square tile, transparent outer padding, a restrained shallow shadow, no circular
badge, text, or extra decoration. Keep the original turquoise gradient.

The tray template is a precise vector reconstruction of the original rectangle
geometry in `../tray-macos.svg`, with white strokes and transparent holes and
canvas. The generated raster tray previews had alpha noise and were discarded.
`../tray-macos.png` is a preview; `../tray-macos.rgba` is the 44×44 RGBA buffer
embedded by Rust. macOS template rendering chooses the menu bar foreground color.

To regenerate the tray exports and ICNS on macOS, run
`node scripts/build-macos-icons.mjs` from the project root with `sharp` installed,
or point `BAAS_SHARP_PATH` at an existing installation. Generated `app.iconset`
files are ignored by Git.

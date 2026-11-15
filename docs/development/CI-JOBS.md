# CI job inventory

This table records the historical module baseline at `2b98f61`, with the client release rows updated for the current packaging contract. See [current module ownership and workflows](CI.md#pull-requests-and-pushes) for the current job graph. Jobs inherit their workflow’s event, ref and path contract in [CI routing](CI.md). A dash indicates no dependency or no explicit cache/artifact action. The setup-tauri-build-env composite restores a Rust cache and optionally downloads fonts and installs Bun. generate-font-assets produces the single generated-fonts artifact. Runner columns list release targets for include matrices; Windows MSVC targets run on Windows, Apple targets on macOS and GNU/Android targets on Ubuntu. The publish-registry matrix runs both registries on Ubuntu. Permissions use r for read and w for write. Retry a failed job with its original inputs as described in the runbook.

Linux client release builds use native `ubuntu-22.04` (x86_64) and `ubuntu-22.04-arm` (aarch64) runners. Each target builds Rust once and bundles signed DEB, RPM and raw AppImage files. The AppImage and its adjacent `.AppImage.sig` are normalized together; the updater retains separate `linux-<arch>-deb`, `linux-<arch>-rpm` and `linux-<arch>-appimage` targets on GitHub, CNB and proxy feeds. Linux ARM32 has no client build or updater target. The shared ARM cross-compilation action remains available to other modules.

For an unpublished packaging check, dispatch **Code Quality** on the feature branch with `mode: appimage-package`. This explicit mode selects only Linux x64 and ARM64. Each native runner tests the client, builds and extracts an unsigned debug AppImage, and retains it as a workflow artifact; this does not create a tag or release. The optional `appimage-smoke` flag also enables packaging for Linux targets selected by other manual modes and defaults to false. ARM64 AppImage execution must be validated on the native ARM64 runner.

macOS update archives publish their signatures in separate, persistent `updater-signatures-aarch64.json` and `updater-signatures-x64.json` source-release assets. They never upload archive `.sig` attachments. The updater feed validates the exact release tag and archive filename before copying the signature into each GitHub/CNB/proxy platform entry. Releases through 0.0.10 retain their historical archive-signature asset contract and read-only fallback.

| Baseline job | Runner or matrix target | Needs | Token permissions | Cache, artifact, publish or mirror steps |
|---|---|---|---|---|
| cli / `cli` | ubuntu-latest, macos-latest, windows-latest | – | contents:r | rust-cache, upload-artifact, upload-artifact |
| code-quality / `changes` | ubuntu-latest | – | contents:r | – |
| code-quality / `generate-fonts` | ubuntu-latest | changes | contents:r | generate-font-assets |
| code-quality / `frontend` | ubuntu-24.04 | changes, generate-fonts | contents:r | download-font-assets |
| code-quality / `desktop-rust` | x86_64-pc-windows-msvc, x86_64-unknown-linux-gnu, aarch64-apple-darwin | changes | contents:r | setup-tauri-build-env |
| code-quality / `android` | ubuntu-22.04 | changes, generate-fonts | contents:r | setup-tauri-build-env |
| code-quality / `quality-gate` | ubuntu-latest | changes, generate-fonts, frontend, desktop-rust, android | contents:r | – |
| docs-validation / `changes` | ubuntu-latest | – | contents:r | – |
| docs-validation / `static-export` | ubuntu-latest | changes | contents:r | upload-artifact |
| docs-validation / `documentation-gate` | ubuntu-latest | changes, static-export | contents:r | – |
| main-source-guard / `source` | ubuntu-latest | – | none | – |
| release-app / `check_tag_version` | ubuntu-latest | – | contents:w, attestations:w, id-token:w | – |
| release-app / `create_release` | ubuntu-latest | check_tag_version | contents:w, attestations:w, id-token:w | – |
| release-app / `generate_fonts` | ubuntu-latest | check_tag_version | contents:w, attestations:w, id-token:w | generate-font-assets |
| release-app / `release` | x86_64-pc-windows-msvc, aarch64-pc-windows-msvc, aarch64-apple-darwin, x86_64-apple-darwin, x86_64-unknown-linux-gnu, aarch64-unknown-linux-gnu | create_release, generate_fonts | contents:w, attestations:w, id-token:w | setup-tauri-build-env, action-gh-release |
| release-app / `release-android` | ubuntu-22.04 | create_release, generate_fonts | contents:w, attestations:w, id-token:w | setup-tauri-build-env, action-gh-release |
| release-app / `update_tag` | ubuntu-24.04 | release, release-android | contents:w, attestations:w, id-token:w | – |
| release-app / `release-update` | ubuntu-latest | update_tag | contents:w, attestations:w, id-token:w | – |
| release-app / `sync-to-cnb-release` | ubuntu-latest | release-update | contents:w, attestations:w, id-token:w | sync-cnb-release, sync-cnb-release |
| release-app / `submit-to-winget` | ubuntu-latest | sync-to-cnb-release | contents:w, attestations:w, id-token:w | – |
| release-app / `notify-qq` | ubuntu-latest | sync-to-cnb-release, submit-to-winget | contents:r | notify-qq |
| release-baasx / `validate` | ubuntu-latest | – | contents:r | – |
| release-baasx / `build` | cli.yml | validate | contents:r | – |
| release-baasx / `publish` | ubuntu-latest | validate, build | contents:w | download-artifact, action-gh-release |
| release-baasx / `sync-cnb-release` | ubuntu-latest | publish | contents:r | sync-cnb-release |
| release-baasx / `publish-registry` | npm, GitHub Packages | validate, build | contents:r, packages:w, id-token:w | download-artifact, download-artifact |
| release-baasx / `notify-qq` | ubuntu-latest | sync-cnb-release, publish-registry | contents:r | notify-qq |
| release-docker / `prepare` | ubuntu-latest | – | contents:r, packages:w | generate-font-assets |
| release-docker / `build-and-push` | ubuntu-latest | prepare | contents:r, packages:w | download-font-assets, login-action, login-action, build-push-action |
| sync-cnb / `sync-repository` | ubuntu-latest | – | contents:r | – |
| sync-cnb / `sync-release` | ubuntu-latest | – | contents:r | sync-cnb-release |
| wiki-pages / `build` | ubuntu-latest | – | contents:r, pages:w, id-token:w | cache, upload-pages-artifact |
| wiki-pages / `deploy` | ubuntu-latest | build | contents:r, pages:w, id-token:w | deploy-pages |

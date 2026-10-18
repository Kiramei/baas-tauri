# Code cleanup and bounty GUI patch

Date: 2026-10-16 (Asia/Shanghai).

## Scope

The client cleanup covers the existing desktop, WebUI, and Android implementation. Backend cleanup is limited to `baas-dev/service` and its regression tests. Earlier backend changes are preserved; no new cleanup is applied to the legacy GUI, task modules, or installer outside `service`.

The bounty change implements the maintainer's final request in [upstream PR #597](https://github.com/pur1fying/blue_archive_auto_script/pull/597#event-33335888212): the new GUI must expose five JP regions and three CN/Global regions. This is a frontend patch; `module/rewarded_task.py` is unchanged by this cleanup.

## Removed redundant implementations

- Removed the unused detached Wiki window component and query route, its native window labels and exclusive permissions. The documentation URL now lives in a small shared module; the existing browser opener remains.
- Removed unused navigation icon fallbacks, collapsed heartbeat presentation, duplicate motion branches, unused imports, and first-frame diagnostic counters. The active heartbeat watchdog remains.
- Removed the unused Android MediaCodec function generator. OpenH264 and the JNI methods called dynamically by Android/Python remain.
- Replaced the duplicate service OCR installer with a compatibility module pointing to the existing implementation. Consolidated the two service Git handlers while retaining their previous import paths and method signatures.
- Removed unused single-session runtime fields, an unused PID helper, and a duplicate remote-session lookup.

## Compatibility fixes

- Android HardwareBuffer functions are resolved lazily. The native library can load on API 24/25 without requiring API 26 symbols; the existing plane-buffer path remains available.
- The Android pygit2 compatibility stub now exposes both callback import paths required by the shared installer. Its regression test imports the real backend helper without performing network operations.
- Kept the old pipe JSON calls, WebSocket mode, terminal task identifiers, and public maintenance APIs.
- Fixed service setup migration so an invalid transport value cannot overwrite the normalized result.
- Bounty controls retain the existing CSV configuration format and `max`. Older JP profiles display their original three values followed by two zero-valued draft entries. Configuration changes are sent only on Save; invalid drafts cannot be submitted.

## Validation

| Check                                                          | Result                                              |
| -------------------------------------------------------------- | --------------------------------------------------- |
| Frontend tests                                                 | 63 passed, 767 assertions                           |
| ESLint, TypeScript including unused declarations               | Passed                                              |
| Seven application locales                                      | 590 consistent keys                                 |
| WebUI production build                                         | Passed                                              |
| Android frontend and CSS conversion                            | Passed                                              |
| Windows Rust workspace tests, all targets, locked dependencies | 155 passed                                          |
| Windows workspace Clippy and rustfmt                           | Passed                                              |
| Android x86_64 Rust Clippy and native library link             | Passed                                              |
| Android bootstrap tests                                        | 5 passed                                            |
| Backend tests (`pytest tests`)                                 | 155 passed, 1 Unix-only test skipped on Windows     |
| Python 3.9 service sources                                     | Compiled; three shared-memory base modules imported |

The Android library was inspected with `readelf`: there are no strong imports of `AHardwareBuffer_*`. No APK was installed and no game input was sent during cleanup. Full Python 3.9 service startup was not tested because that interpreter lacks FastAPI. Linux/macOS and Android arm64 were not run on this machine.

The final Windows production build (`tauri build --no-bundle`) passed. Its executable is 10,657,792 bytes, SHA-256 `94ECC13CF8CC4C5B3057AD1311F6C8F067E6480B1ED7B5E14C39CC7B358438FB`. It was built after the WebUI and Android checks, restoring `dist` to desktop mode. The running user preview was not restarted as part of the cleanup builds.

The version remains `0.0.8-rc`. This work is a branch commit/push, with no release tag, stable updater publication, Winget publication, or workflow dispatch. Documentation changes are maintained in Chinese and English; application translations remain in all seven existing languages. Local screenshots, build manifests, Python bytecode, and tool worktrees are excluded from commits.

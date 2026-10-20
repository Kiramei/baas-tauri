# Documentation refresh audit

This ledger preserves the full requested scope. **The refresh is not complete.**
The current checkpoint updates bilingual feature configuration, settings,
profiles, runtime, updates and Android provenance; it is not the final
documentation delivery.

## Sources and Isolation

- Desktop: `origin/dev` at `be186c524ab9f7a91c41582aec3a5fef06614751`.
- Android: `origin/android-dev` at `5ca0ac7ca88ec8523d17bfbd9aca0750d8ba7d78`.
- Backend code audit: `baas-dev` at
  `d0a86a089068766ff53682b501b90bee99857a71`. The fresh Android first run
  downloads the configured `master` archive; the new friend-filter omission
  was also checked in that actual installed source. Do not infer the archive's
  Git revision from the local audit revision.
- Docs checkout: `../baas-tauri-docs`, branch `docs/dev-refresh`.
- Git cannot create `dev/docs` while `dev` exists. No shared branch was
  renamed/reset; the main checkout remains on its existing fix branch.
- All tracked edits are confined to `docs/`. Native desktop capture uses
  `../.codex_tmp/docs-refresh`. Fresh Android builds use a separate checkout,
  `../baas-docs-android-validation`, branch `docs/android-validation`.
  The existing `android-dev` checkout was not edited.
- Captures show actual native Tauri/WebView UI with isolated demo profiles,
  not frontend fixtures. They do not prove successful game-task execution.

## Requirement Audit

| Requirement                                          | Current evidence                                                                                                                               | Remaining work                                                                        |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| No external landing page                             | SiteHome removed; root/docs enter internal localized docs                                                                                      | Final deployment checks                                                               |
| Environment language, English fallback, saved choice | Focused locale/link tests; browser entry, denied-storage and manual-persistence cases pass                                                     | Deployment prefix behavior                                                            |
| Chinese/English parity                               | All 17 configuration categories, six settings categories, profile/runtime/update workflows and expanded architecture in both languages         | Installer/setup/repair and remaining developer pages                                  |
| Every current desktop UI detail                      | Manual configuration/workspace audit; compiler-AST coverage of 79 draft fields, nine immediate commands, settings labels and shortcut IDs      | Installer and remaining surfaces; conditional capture/interaction review              |
| Fresh light screenshots                              | 112 desktop + 48 freshly rebuilt Android captures, manifests, two real GIFs; real nonblank remote-preview frames verified                      | Conditional selectors/dialogs, installer, live game; replace other old references     |
| Necessary GIFs                                       | Actual automatic-save/undo recordings with reader-controlled playback                                                                          | Assess graph, structured-editor and game motion                                       |
| Rounded/shadowed media                               | 8px radius/shadow and layout checks pass in tested theme/viewport combinations                                                                 | Remaining pages and deployment prefix                                                 |
| Developer principles                                 | Architecture explains ownership, drafts/ACKs, graphs, framing/batching, recovery and Android process separation                                | Auth/protocol, updater, recognition/backend and native implementation depth           |
| Interactive explanations                             | Working p50/p95 chart controls, GIF playback and localized diagram zoom/reset with a scrollable viewport                                       | Assess further useful diagrams/components                                             |
| Rigorous benchmark charts                            | Fresh encoding/store samples, raw data, environment, commands and bounded claims                                                               | Review native/backend/mobile measurement needs; no microbenchmark extrapolation       |
| APK installed                                        | Fresh pinned-source ARM64 and x86_64 APKs built/installed, hashes and commands recorded                                                        | Release/real ARM device coverage is not established                                   |
| Android runs beyond installation                     | First-run download/auth/config sync, native Shizuku permission, x86_64 display and native control overlay                                      | Healthy game frame, input, task completion, takeover/restart and background lifecycle |
| Android operation explained                          | Rewritten first-run, exact regional packages, authorization states, read-only preview, shared run slot, lifecycle and notification limitations | Finish game validation and reconcile remaining settings/update/error details          |
| Docs mobile/light/dark                               | 168 render cases across 21 routes, two languages, two themes and two viewport sizes                                                            | Remaining site pages/final full audit                                                 |
| Search/links/media/build                             | 177 browser cases; 74 exported HTML pages checked; 75-route build                                                                              | Recheck after future edits and final deployment                                       |
| Final review/delivery                                | Verified incremental checkpoint only                                                                                                           | Finish full scope, final review and PR                                                |

## Configuration Checkpoint

`evidence/configuration-coverage.json` maps every registered category to its
source/editor and bilingual page. The compiler-API test detects changes to
Draft/inline-initial field shapes and verifies mapped field mentions/commands.
It does **not** prove prose accuracy, every conditional UI state, backend
implementation or game execution.

The manual audit covers Cafe, Lessons, both shops, all Crafting stages, Arena,
Total Assault, Final Restriction Release, Drill, daily/event sweeps, friends,
Server, Script, Emulator, exploration/story/events, Teams, Push and Other.

Important source-verified caveats are explicit in both languages:

- Cafe's empty named invitation list falls back to lowest affection.
- Empty Lesson tier selection is not a disable switch.
- Shop UI permits 0-5 refreshes; audited backend caps both shops at three.
- Arena threshold/zero refresh does not guarantee skipping the challenge.
- Event integer `1` differs from `1.0`; AP shares round down and targets
  over 50 trigger the audited backend's all-AP recalculation.
- Friend cleanup ignores the new filters in the audited/default installed
  backend and deletes non-whitelisted friends. It was not executed.
- Final Restriction Release controls do not establish corresponding backend
  implementation. Tauri autostart consumption was not found outside its editor.
- Stage/uncensor Execute commands act immediately; they are not Save buttons.

## Workspace Checkpoint

The bilingual System, Profiles, Home Runtime and Updates guides were rebuilt
against the pinned desktop source and audited backend. The architecture guide
now describes preference/profile ownership, archive commands, log retention and
durable idle-update recovery. Source findings that affect safe operation are
explicit in both languages:

- Same-name ZIP import replaces the existing profile directory without an
  additional frontend overwrite confirmation. ZIP export includes all files in
  that profile directory and may contain private data.
- The advanced remote-preview size labels are swapped relative to their bound
  fields. Saving can apply the old state snapshot; close and reopen the camera
  preview to reconstruct it from newly stored settings.
- Task logs and system diagnostics are separate. Copy/Export uses the filtered
  system-log view; Clear affects all sources after confirmation. Retention and
  truncation limits prevent treating it as a complete filesystem log archive.
- Application shortcut editing and global profile shortcuts have different
  scopes, validation and save behavior. Idle-update recovery restores scheduler
  states, not an interrupted battle frame.

Thirty new native desktop screenshots document actual profile/settings/log
dialogs. The capture verified invalid-name rejection, a locked profile server,
cancelled deletion/log clearing, Escape cancellation and reserved-key rejection.
It did not create/import/export/delete profiles, clear logs, save or exercise
new global hotkeys, run tasks or install updates. The real global recorder may
temporarily suspend and restore existing OS shortcut registrations.

Six further native screenshots show a real desktop preview of MuMu's Android
BAAS interface and the expanded/advanced controls. Pixel probes found decoded
400 x 720 frames with multiple colors in both locales. No game-input, clipboard,
power or new video-setting commands were sent; the preview was closed afterward.
This is not proof of healthy Android game rendering or task completion.

`evidence/workspaces-coverage.json` and the compiler-API tests cover six settings
sections, statically labelled settings/remote inputs, application shortcut IDs
and profile command names. They detect mapped source drift, not semantic
completeness, OS/device effects or every conditional state.

Both diagrams pass exact 150%/800% width-ratio, zoom-out, reset, disabled-state
and internal-scroll checks in the eight locale/theme/viewport combinations.
Initial layout retains each diagram's natural dimensions. Additional light/dark
390px visual checks verified readable 400% diagrams and no document overflow;
the desktop vertical diagram fits without unwanted enlargement. Two separate
visual probes timed out; six isolated direct-load probes and repeated final
captures passed. The cause of those timeouts was not established. Final browser
evidence includes all 177 cases.

## Fresh Android Evidence

- ARM64 package: `io.github.kiramei.baas_tauri.docs`; APK 102,086,504 bytes,
  SHA-256 and build/install results in `evidence/android-arm64-validation.json`.
- MuMu advertises x86_64/ARM64 translation. Its x86_64 Shizuku process cannot
  load the ARM64 `libbaas_display_capture.so`: EM_AARCH64 vs EM_X86_64.
  ARM64 installation and Home therefore do **not** prove the game path works.
- The existing x86_64 build path produced a 106,607,198-byte APK without tracked
  app-source changes. Package `io.github.kiramei.baas_tauri.docs.x86`;
  provenance in `evidence/android-x86-provenance.json`.
- Shizuku v13.6.0 was downloaded from its official GitHub release and installed
  separately. The manager's actual native startup command was used, followed by
  the real authorization dialog. Service UID 2000 was reported.
- A new Bilibili `Documentation Demo` profile has all 26 task switches off.
  The existing user `smoke-bilibili` profile was not edited.
- x86_64 created a virtual display and native preview/control overlay. The game
  remained at a startup image and its Unity activity appeared on the main
  display, so real game input/task completion is still **unverified**.
- The native preview is read-only. The audited foreground notification has no
  Start/Stop actions; Shizuku initialization also attempts notification
  suppression. Obsolete bundled-installer/backend and notification-toggle
  claims have been removed from the Android guide.
- The 48 Android screenshots now identify the fresh x86_64 APK. They use actual
  light theme and the actual Appearance resource-display toggle off, avoiding
  overlapping Home resource labels without modifying application code.
- `evidence/android-install-smoke.json` is historical evidence for the older
  preexisting APK, not the provenance for the new screenshots.

## Next Implementation Steps

1. Capture and verify missing conditional configuration states (named/starred
   Cafe, student selectors, Crafting phase 2/3/recommendations, preset grids,
   structured legacy/invalid states and relevant dialogs).
2. Rewrite install/setup/repair and remaining platform-specific details against
   current source; extend the audited settings/profile/runtime/update pages as
   further native and backend execution evidence becomes available.
3. Expand backend/recognition/auth/updater/native developer principles; review
   existing measured evidence before choosing further benchmarks.
4. Finish the Android game display/Unity transition investigation, then verify
   real input, a low-risk supervised task, takeover/restart and service/activity
   cleanup. Do not test friend deletion, paid purchases or uncensoring.
5. Reconcile remaining bilingual content and old images; assess additional
   explanatory interaction and GIFs without claiming untested behavior.
6. Audit every page in desktop/mobile/light/dark, search, links/media and deployed
   base path, then review the docs-only PR. Do not merge this checkpoint as if
   the entire goal were complete.

## Runtime Handles

- Preview: `http://127.0.0.1:4173/`, static server serves `docs/out`.
- Desktop capture native PID was 39168, CDP 19230; revalidate before reuse.
- Device: `127.0.0.1:16384`.
- Fresh x86_64 WebView PID was 6147, forwarded on 19233. Re-discover after restart.
- Earlier `.dev` and ARM64 `.docs` validation apps were stopped to avoid
  conflicting backend ports. No game scheduler was started during this pass.
- Android/desktop resource-label overlap is an app-source issue, not fixed here.
- Windows Next 16 export still has a segment-prefetch nested/dotted-path mismatch:
  normal navigation passes, but Linux/Pages output requires verification.

## Verification Scope

`bun test tests`: 15 tests / 368 assertions, including field-shape/document
coverage. These are docs checks, not a substitute for application tests.

`bun run build`: 75 routes. Static link scan: 74 index HTML pages, excluding the
separate not-found route. Browser suite: 177 cases (168 render combinations plus
entry/search/language checks), including both architecture diagrams and zoom
interactions. Static links, anchors and media have zero reported failures. The
static-link command needs the same optional `PLAYWRIGHT_MODULE` environment
override as browser smoke checks when Playwright is not installed locally.

Every requirement still listed as remaining is unachieved.

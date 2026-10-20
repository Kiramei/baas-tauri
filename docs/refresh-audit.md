# Documentation refresh audit

This ledger preserves the full requested scope. **The refresh is not complete.**
This goal turn made progress: implementation, native captures, emulator
installation and runtime/browser verification all changed authoritative evidence.

## Sources and isolation

- Desktop: `origin/dev` at `be186c524ab9f7a91c41582aec3a5fef06614751`.
- Android: `origin/android-dev` at `5ca0ac7ca88ec8523d17bfbd9aca0750d8ba7d78`.
- Documentation checkout: `../baas-tauri-docs`, branch `docs/dev-refresh`.
- Git cannot create `dev/docs` while the `dev` branch exists. No existing branch
  was renamed/reset. The original checkout remains on its existing fix branch.
- Edits are confined to `docs/`. Native builds use an isolated target directory
  and a separate real backend under `../.codex_tmp/docs-refresh`.
- New screenshots are native Tauri/WebView captures, not fixture screenshots.
  They prove UI state, not successful game execution.

## Requirement audit

| Requirement                                       | Current evidence                                                                                                                | Remaining work                                                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| No external landing page                          | Verified: SiteHome removed, root/docs entries enter internal localized docs                                                     | Preserve behavior through final deployment checks                                                                 |
| Browser language, English fallback, manual choice | 11 focused tests (19 assertions) including links; browser entry/storage-denied/manual persistence cases pass                    | Verify deployment base path and any future route changes                                                          |
| Chinese/English parity                            | New index/interface/configuration/scheduler/architecture/performance and Android additions exist in both languages              | Reconcile every remaining feature field, condition, action and error state                                        |
| Every current desktop UI detail                   | Native inspection and observed control inventory in `evidence/desktop-controls.json`                                            | Full source-to-page matrix; remaining feature/settings/runtime/install pages are not yet rewritten                |
| New light screenshots                             | 76 desktop + 48 Android captures, manifests and 2 real UI GIFs                                                                  | Replace remaining old references; capture conditional selectors/dialogs, installer and real runtime/game state    |
| Necessary GIFs                                    | Native setting-toggle/automatic-commit/undo recordings, reader-controlled playback                                              | Assess and capture graph/structured-editor/game workflows that still need motion                                  |
| Rounded/shadowed media                            | Computed 8px radius and nonempty shadow pass on tested routes in both themes and viewport sizes                                 | Verify remaining pages and deployment prefix                                                                      |
| Developer principles                              | New architecture page covers ownership, drafts/ACKs, graph patching, transport recovery, framing/batching and Android lifecycle | Expand updater, auth/protocol, recognition/backend and native/mobile implementation explanations                  |
| Interactive explanations                          | Working p50/p95 controls and GIF playback tested                                                                                | Determine if further diagrams/components improve complex rules                                                    |
| Rigorous benchmark charts                         | Fresh encoding/store measurements, all samples, environment, revision, commands, units and explicit limits                      | Review performance coverage of native/backend/mobile paths; do not extrapolate microbenchmarks                    |
| APK installed in user's emulator                  | ARM64 APK installed successfully; ABI includes arm64-v8a; version/hash in `evidence/android-install-smoke.json`                 | Rebuild from pinned Android source to establish fresh provenance                                                  |
| Android works beyond install                      | Cold launch, health, navigation, theme/language, real config save across WebView reload verified                                | Privileged display, nonblank game preview, input and real task execution/lifecycle tests                          |
| Android operation fully explained                 | Current workspace/category differences and new screenshots added                                                                | Complete first-run authorization, game selection/preview/takeover, notifications, startup/update/lifecycle/errors |
| Docs mobile/light/dark                            | 40 render/interaction combinations across 5 changed routes, 2 languages, 2 themes and 2 viewports pass                          | Cover the remaining rewritten routes in final audit                                                               |
| Search/links/media/build                          | 49 browser checks pass; 74 exported HTML pages have no missing internal targets/anchors/media; 75-page static build succeeds    | Recheck after remaining edits; deployment-specific behavior                                                       |
| Final review/delivery                             | This is a verified foundation checkpoint                                                                                        | Complete full requirements, review scoped diff, then deliver the final PR                                         |

## Implemented content

- Internal documentation index, current interface and navigation.
- New configuration-workspace page: search, tabs, automatic persistence,
  invalid drafts, history isolation and structured-editor overview.
- Rewritten scheduler: single list, sorting, bulk scope, timing dialog,
  graph port ownership, validation, immediate patches and local layout.
- Android workspace additions and light native captures.
- New bilingual client architecture and performance pages.
- Source-relative MDX link resolution fixes the trailing-slash navigation bug
  throughout old and new pages; public MDX asset paths honor the build prefix.

## Next implementation steps

1. Read every control, option list, serializer and conditional block in all 17
   desktop configuration sections. Reconcile each feature page and replace old
   pictures with the relevant captures; collect missing conditional states.
2. Rewrite all six settings categories, profile operations, runtime/log/remote
   display flows and installer/setup/repair/update pages against current code.
3. Finish backend/recognition/auth/updater/native developer principles. Review
   existing measured evidence before deciding which additional benchmarks run.
4. Build an isolated APK from the pinned Android source. Validate Shizuku,
   game package selection, virtual display/preview, input, real task completion
   and service/activity cleanup. Keep the existing user profiles intact.
5. Complete Android instructions and bilingual parity. Check every old screenshot
   reference and every documentation page, not only the already rewritten subset.
6. Final desktop/mobile/light/dark/search/link/media/build audit, then PR review.

## Runtime handles and reproducibility

- Documentation preview: `http://127.0.0.1:4173/`, static server rooted at `docs/out`.
- Isolated desktop native process was launched as PID 39168; revalidate before
  reuse. DevTools port 19230. No game tasks were run in the capture pass.
- Android device `127.0.0.1:16384`; installed dev package
  `io.github.kiramei.baas_tauri.dev`. WebView PID was 3167, forwarded on 19231;
  re-discover its socket after a process restart.
- Android capture uses a newly created `Documentation Demo` profile. Existing
  `smoke-bilibili` profile was not edited.
- Browser checks and screenshots: `.cache/docs-smoke`; capture/measurement
  commands and prerequisites are described in `README.md`.
- Native Home resource labels overlap in the current English client. Published
  runtime overview uses the actual resource-display toggle off; this docs pass
  does not modify application code to conceal that source issue.
- Next 16 Windows static export emits nested segment-prefetch files while some
  browser prefetch requests use dotted names. Normal navigation passed, but
  check Linux/Pages output before declaring deployment verification complete.

## Verification scope

`bun test tests` (docs) passes 11 tests / 19 assertions.
`bun run build` (docs) produces 75 routes.
`smoke-docs.mjs` passes 49 browser cases.
`check-static-links.mjs` finds zero broken targets/anchors/media in 74 exported
index HTML files (the build also counts the not-found route).
The browser suite covers index language behavior and five updated content routes,
not all feature pages. Unverified requirements above remain unachieved.

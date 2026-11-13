# CI routing and release recovery

The measured baseline covers 18 GitHub runs and 19 attempts. The implementation base is `2b98f61` (2026-11-11). The repository had nine YAML workflows at that revision. [Measured baseline](CI-BASELINE.md) · [Baseline job, matrix, permission and artifact inventory](CI-JOBS.md)

## Events, revisions, and outputs

| Event | Before | After |
|---|---|---|
| Feature PR to dev | Separate quality and documentation detectors plus path-triggered three-OS CLI packaging | Code Quality checks GitHub’s merge commit against its exact base parent. One plan controls both required gates. Heavy jobs depend on their consumers. |
| PR to baasx-dev | CLI path filter and full package builds | Same merge-context validation. Direct pushes to this development branch separately test the actual push tree. |
| Push to dev | Full CLI pipeline for matching paths | No generic CI. The strict dev PR checks own integration validation. Direct maintainers bypassing required PRs can dispatch full validation of that ref. |
| dev → main PR | Source check plus three-platform CLI packaging on matching paths | Source guard reads event metadata using empty permissions. Code Quality additionally tests the main merge tree, including changes since the main base. The two named dev gates are emitted but only the source check is currently required on main. |
| main push | CLI packaging, website deployment and repository mirror on matching paths | Pages publishes actual site inputs; repository sync mirrors Git history. Neither claims to satisfy a PR gate. Manual Docker build on main still publishes the main/latest image. |
| App version tag | Checked against main; platform installers, manifests, Docker image, CNB, optional Winget, QQ | Same product entry points; verify all required installable and signed asset names before publication. Stable/post can advance latest, RCs go to preview. Plain and fixed WebView2 keep distinct binaries and endpoints. |
| `baasx-v*` | Independent version and baasx-dev ancestry, three full builds, registries, CNB, QQ | Same release entry point; uses the explicit packaging workflow. Checksums cover three native archives and three Bun packages. Same-run artifacts supply the Node registry bundle and native helpers. |
| Manual Code Quality | Full checks | `contracts` runs the routing/gate/notification/release fixtures; `full` runs every verification mode. Use CLI packaging dispatch when actual distributables are needed. |

Docs validation moved into Code Quality. `Dev quality gate`, `Dev documentation gate` and `Main branch source` retain their original GitHub Actions check names. The metadata-only source guard still uses `pull_request_target` without a checkout. Code execution uses `pull_request` with read-only permissions and disabled checkout credentials. The final gates inspect the plan, detector conclusion and all expected jobs. An absent result, canceled check, a skipped relevant job or a job running outside its plan fails the gate. Drafts use the normal plan and `ready_for_review` runs again. A new event for the same PR cancels stale work. Strict dev protection requires an updated merge context after the base advances.

## Impact and verification modes

`scripts/ci/impact.py` owns the rules, runner matrix and gate expectations. The detector diffs Git objects with NUL delimiters and rename detection disabled so moving files contributes both paths. PRs validate the actual base/head parents and the merge tree, not the file-list API. Pushes compare before/after and fetch an absent base; first pushes verify everything. Ambiguous parents, missing objects, unknown events and broken plans block the gate. Unknown paths select full verification. The run summary records each selected input or why a task was skipped.

| Inputs | Work |
|---|---|
| Ordinary README and release notes | Release/pack contracts. Root README links are also verified by docs/tests. |
| Docs site content, MDX, components, evidence and test scripts | Linux static export and browser/contract tests; failure-only diagnostic artifact for three days. Development runbooks are not site inputs. |
| Notification, mirror, release tag and version logic | Local fixtures exercise the HMAC payload, failed CNB readiness, archive names, updater signatures, Docker tag decisions and monotonically advancing app versions. |
| Android-only frontend / WebUI-desktop shell / shared app code | Android bundle / webui+tauri bundles / all applicable modes. One type check and one translation validation in the frontend job; Android native builds validate their own web bundle. |
| Client sources and Rust inputs referenced by docs | Docs exports re-run conservatively. These tests inspect client API registration, real types/translation keys, settings and the updater source manifests. |
| baasx JS / OS-dependent runtime, process, PTY or packaging code | Pinned compiler, types, lint, tests and JS bundles. OS inputs add selected helper tests and Node smoke jobs, without package archives. `--js-only` excludes Cargo metadata/build/copy steps. |
| CLI runtime crate | CLI checks and three helper targets. Shared baas-term/updater propagate to desktop, Android, CLI and docs. Shortcut crate is desktop-only. Notifier is shared with Android. |
| Platform package templates and Rust source, Android Gradle/JNI/Python | Corresponding desktop runner or Android backend tests plus arm64 debug APK and release lint. |
| Rust workspace, lockfile, CI planner or unclassified build inputs | Full conservative plan. Root Bun/dependency configuration propagates to client, docs and CLI consumers. Changes to the shared Tauri action select its desktop/Android consumers. |

No cross-run package or native binary is trusted as input. CLI release artifacts have seven-day retention and precompressed native/Bun archives are uploaded with compression level zero. PRs upload no distributions. All PR artifact consumers are in the same workflow (generated fonts, retained one day). The font source includes a mutable upstream master file used to derive subset characters. A cross-run cache keyed solely by local files could serve incomplete fonts. Keep font generation per consuming workflow until that remote text is content-addressed and the Python/fonttools/Brotli toolchain is pinned. Docs Pages caches dependency downloads by lockfile; its production artifact stays within the same run. Rust keys distinguish compiler, OS, runner architecture, target and package/test variant in addition to the cache action’s dependency inputs. A tag cache is scoped to its Git ref; it is not a PR baseline. CLI debug caches can be written by trusted baasx-dev pushes. A cold cache always runs the same checks. Broader base-branch warming adds builds and needs fresh measured evidence.

## Release recovery

Use the same tag and the original workflow attempt. In GitHub Actions choose **Re-run failed jobs**, or `gh run rerun RUN_ID --failed`. CNB and QQ are separate downstream jobs; a failed mirror does not rebuild platform binaries, and a failed QQ delivery does not republish packages. Docker image mirroring is a separate job after Docker Hub/GHCR publication. The baasx registry verifier compares integrity before reusing an existing version. If a previously missing historical package is backfilled, npm and GitHub Packages publish it with the historical tag so a newer latest or next remains selected. The full CLI release workflow pins the Bun compiler and full revision; root builds use their own supported Bun version.

Automatic CNB sync validates the product’s full published asset list and checks readiness once. A manual Source Dispatch run can wait for a release that has not finished. Select the exact tag and use the required artifacts from the original publication; check GitHub and CNB checksums before retrying an interrupted manual transfer. Notifications are HMAC signed and run after the original app mirror/Winget or baasx mirror/registry dependencies. No notification or release is sent by any PR or Code Quality dispatch.

App/baasx/Docker side effects each use a product publication concurrency group with `queue: max` so the normal single pending slot cannot discard an intervening tag. GitHub permits 100 pending entries per group; an overflow must be retried. Queue order is the order in which runners reached the group, not numerical version order. App promotion compares all published stable versions. The updater regenerates stable/alpha manifests from paginated public releases even on historical reruns, and CNB reads the current updater release only after GitHub publication. Docker checks the published release sequence and the current latest image label. Keep fixed/normal Windows builds independent: the executable embeds its product config and updater endpoints; a shared binary is not equivalent. [GitHub concurrency behavior](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)

## Historical replay

Using complete PR file lists, not an API `head_sha` identity assumption:

| Change | Historical | Expected after routing |
|---|---|---|
| #95 | CLI Linux/macOS/Windows packaging 828 job seconds, in addition to docs/quality | Detector, local package contracts, real docs export, both gates. No CLI matrix/package upload. |
| #97 | 2,724 job seconds across matching workflows | Detector, contracts (QQ signing, release policies, package fixtures), both gates. No platform, fonts or docs job. |
| #98, head 8a0ada2 | Three distinct push/PR CLI runs for the same reported head; the main merge tree can differ | dev push has no generic build; baasx-dev push checks the actual push delta; main PR checks the merge delta plus trusted source guard. For the observed release/notes-only change these routes select contracts. |

These are expected selections. Runner-seconds removed from a historical matrix are measured baseline resource use; the new wall time and future savings require real PR samples. Full release assembly remains available, so this replay does not claim reduced release time.

## Operating and migrating

1. Add a component rule and positive/negative examples to `scripts/ci/test_impact.py`. Add a job to the plan, its needs in the appropriate named gate, plus relevant merge-context tests. Unknown paths already expand to full coverage.
2. Run `python3 -m unittest discover -s scripts/ci`, `bun test tests/frontend/{CiPolicy,ReleaseWorkflows,ReleasePublishing}.test.ts` and the two baasx registry fixture suites. Replay local commits with `python3 scripts/ci/impact.py replay BASE_SHA TESTED_SHA`.
3. Evaluate the candidate on a dev-targeted PR and inspect both old check **names**, source app **GitHub Actions**, and the test merge SHA. A workflow-dispatch run only validates its selected ref; it does not fulfill a protected PR status.
4. No ruleset update is required for compatibility. Keep the confirmed strict dev requirements in place. If maintainers decide to require the quality/docs gates on main, first observe both contexts on an actual promotion PR, add those exact GitHub Actions contexts alongside `Main branch source`, and require an up-to-date branch only if approved. No merge queue was observed; enable `merge_group` and test its merge parents before enabling one.
5. Roll back by reverting the CI commits together (restore the two original gate workflows and triggers). Keep the existing protected names during rollback. Remove only optional newly added main requirements after the original source guard and dev gates are confirmed successful on the test PR. A PR editing its own checker remains a code-review trust decision; protect CI/action changes with existing review policy.

The full job/attempt timing data and API access limits are recorded in [CI-BASELINE.md](CI-BASELINE.md).

## Candidate job graph

The eight workflow files implement the jobs below. Per-job limits and exact runner labels remain visible in the YAML. The three release flows intentionally have independent concurrency groups, versions and endpoints.

| Workflow | Jobs and dependencies | Output and recovery |
|---|---|---|
| Code Quality | `changes` → selected contracts, fonts, Android tests, docs or CLI sources. Fonts → frontend. Applicable contracts/CLI source → desktop matrix. Fonts + Android tests → APK. Applicable CLI source → helper/OS matrix. Both named gates run even when dependencies fail or skip. | Explanatory job summary, one-day fonts, three-day docs diagnostics on failure. Retry failures for the same merge SHA. |
| baasx CI | One three-OS release/package matrix, dispatched explicitly or called by Release baasx after tag validation. | Same-run six distributables plus JS bundle, seven days; retry the failed matrix children. |
| Main Branch Source | Single read-only source job using the base workflow and PR event data. | Required main check. Fix the source ref and let the PR event rerun it. |
| Release App | Tag → draft/fonts → desktop, Linux ARM, Android and fixed WebView2 builds → complete-asset validation/publish → updater manifests → stable CNB → applicable Winget → QQ. | Signed installers and rolling update descriptors; retry failed downstream from the Actions run. |
| Release baasx | Validate → reusable package build → GitHub assets and registry publication; CNB waits for GitHub; QQ waits for CNB and both registries. | SHA256SUMS, archives, npm/GitHub Packages. Historical attempts with expired artifacts must rebuild the same tagged inputs. |
| Release WebUI Docker Image | Prepare/fonts → build+push → mirror. Nonpublishing branch dispatch builds only. | Version/SHA and applicable latest tags in GHCR, Docker Hub and CNB. A failed mirror can run again without Docker Buildx. |
| Source Dispatch | main push or manual repository operation mirrors Git. Manual release/all can wait then mirror a selected release. | Manual release mirror shares the product publication lock. Readiness defaults differ intentionally between downstream and independent recovery. |
| Deploy Wiki to GitHub Pages | main site inputs or dispatch → build → deploy through the github-pages environment. | Single GitHub Pages artifact; retry deployment on the same run. |

For a new protected ref, register the PR trigger before requiring any contexts. Keep Code Quality and the source guard on separate permission/concurrency scopes. Legacy `docs-validation.yml` manual users select **Code Quality → full**. There is no top-level path filter on required PR checks.

## Local acceptance

On 2026-11-13 the router/gate/QQ/CNB/promotion unittest suite passed seven tests. The CI policy, publishing, workflow, registry pack/install and registry double-publish fixture suites passed 30 Bun tests. The pinned compiler `b1007f1177fd402fae67387b8548cae5ae9b5707` built the two JS bundles with `--js-only`; the Node demo ran successfully and no release helper was created. actionlint 1.7.12 passed with one narrowly scoped syntax exception for GitHub’s newer documented `concurrency.queue`; separate tests require `queue: max` and prohibit cancel-in-progress on publication. All YAML files parse and the diff passes `git diff --check`.

The release fixture tests use local archives and simulated API responses. This audit did not publish a release, push a container image, upload an npm package, modify rulesets or send a QQ notification. Whole-platform packaging, Docker publication, CNB mutation and real PR-required-check association remain release or rollout validations.

[GitHub verification run 43419375504](https://github.com/Kiramei/baas-tauri/actions/runs/43419375504) succeeded for implementation commit `5fa289e` using a read-only Code Quality dispatch in contracts mode. The planner took 7 seconds, release contracts 8 seconds, docs gate 4 seconds and quality gate 7 seconds. This is 26 Linux job-seconds and 25 seconds from first job start to final gate completion, with zero macOS/Windows jobs and zero artifacts. Eight unneeded jobs were skipped. This validates the ran/skipped contract and both named gate conclusions on GitHub; rollout must still observe PR check association on an actual merge ref. The follow-up documentation commit records these results.

The registry backfill change was then verified on [implementation commit 0159ced, run 43419926276](https://github.com/Kiramei/baas-tauri/actions/runs/43419926276). All four planned Linux jobs succeeded and the other eight jobs skipped. The run took 30 seconds from creation to completion, including a four-second initial delay, used 26 Linux job-seconds, and produced zero artifacts. The contracts job included the lightweight package/registry fixtures. This second run did not build or publish release packages.

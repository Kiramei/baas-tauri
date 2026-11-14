# CI routing and release recovery

The measured baseline covers 18 GitHub runs and 19 attempts. The implementation base is `2b98f61` (2026-11-11). The repository had nine YAML workflows at that revision. [Measured baseline](CI-BASELINE.md) · [Baseline job, matrix, permission and artifact inventory](CI-JOBS.md)

## Pull requests and pushes

Code Quality compares GitHub’s PR merge tree with its exact base parent, including both sides of a rename. It sends the resulting paths to the ownership rules in `scripts/ci/impact.py`. Each selected module has its own workflow. All PRs report the existing **Dev quality gate** and **Dev documentation gate** checks. On a source-only PR the documentation gate verifies the docs workflow was skipped. On a README-only PR the source gate verifies the build workflows were skipped. The separate base-controlled **Main branch source** check continues to validate promotion PRs.

Direct pushes to baasx-dev use the before/after tree diff. On main, wiki-pages only deploys site inputs and Source Dispatch mirrors the repository. Creating an app version tag builds the complete signed client release and Docker image. A `baasx-v*` tag builds the independent BAASX release. Tag builds assemble complete distributions regardless of the last commit’s changed paths.

| Changed input | Selected verification |
|---|---|
| README, release notes, crate documentation, development runbooks | Lightweight Markdown and README checks in docs-validation. |
| Site content, components, media, browser checks, evidence, docs dependencies | Independent docs static export, browser checks and documentation contracts. |
| Client shared UI or assets | Frontend type checks, tests and WebUI, Tauri and Android bundles. Desktop and Android shell entries select only their own modes. |
| `src/android/`, Android UI components | Android UI type checks, tests and bundle. |
| `src/platform/{windows,macos,linux}/` | Corresponding OS frontend adapter checks and consumer build on its native runner. |
| Client native public API, Rust app manifest | Desktop client tests on one representative host per OS, plus Android native verification. |
| `src-tauri/src/platform/desktop.rs`, desktop-only commands | Desktop client Rust tests. |
| OS-specific Rust, OS package inputs | Only the corresponding native client platform. An architecture subdirectory selects its target, e.g. `platform/windows/arm64/`. Intel and ARM64 Windows WebView2 configuration changes also select their exact targets. Linux armv7 uses the release sysroot for a cross-check. |
| Android Kotlin/JNI/Gradle/Rust | Android backend tests, native test APK and lint. Native test APKs embed a minimal test page. Signed releases embed the real frontend. Python-only changes run the Android backend tests. |
| BAASX command/UI TypeScript | BAASX source checks and JS bundle. Windows and POSIX process adapters receive OS-specific JS checks. |
| BAASX Rust helper | Test the primary `baasx-runtime` crate and its legacy `baas-cli-runtime` compatibility entry on the supported OS/CPU pairs. |
| BAASX npm package assembly, launchers and registration | Package assembly, registry retry and local installation tests. |
| Shared protocol and Rust crates | Their declared consumers. The UI and BAASX share authenticated transport and a small number of configuration parsers. Desktop/Android/CLI consume different Cargo features. |
| Docker scripts | Docker entrypoint tests. |
| Router, release and notification configuration | CI and release contract tests and workflow lint. |

An unknown top-level source path fails the routing step and names the unassigned path. Add its owner and a routing example before merging. The router compares both Git revisions of shared manifests and lockfiles. It traces changed packages to their Bun workspace or Cargo root consumers. When an input cannot be attributed, it checks all consumers of that ecosystem. CI ownership applies to module source and shared build inputs. For a manual run select **Code Quality → changes** to test a commit against its parent, **contracts** for CI and registry fixtures, or **full** for all module suites. For a build of one distributable, use **Code Quality → baasx-package** and select its OS and CPU. The release workflow always requests all six. The docs workflow also offers **site**, **readme**, and **full** manual runs.

## Release recovery

Use the same tag and the original workflow attempt. In GitHub Actions choose **Re-run failed jobs**, or `gh run rerun RUN_ID --failed`. CNB and QQ are separate downstream jobs; a failed mirror does not rebuild platform binaries, and a failed QQ delivery does not republish packages. Docker image mirroring is a separate job after Docker Hub/GHCR publication. The baasx registry verifier compares integrity before reusing an existing version. If a previously missing historical package is backfilled, npm and GitHub Packages publish it with the historical tag so a newer latest or next remains selected. The full CLI release workflow pins the Bun compiler and full revision; root builds use their own supported Bun version.

Automatic CNB sync validates the product’s full published asset list and checks readiness once. A manual Source Dispatch run can wait for a release that has not finished. Select the exact tag and use the required artifacts from the original publication; check GitHub and CNB checksums before retrying an interrupted manual transfer. Notifications are HMAC signed and run after the original app mirror/Winget or baasx mirror/registry dependencies. No notification or release is sent by any PR or Code Quality dispatch.

App/baasx/Docker side effects each use a product publication concurrency group with `queue: max` so the normal single pending slot cannot discard an intervening tag. GitHub permits 100 pending entries per group; an overflow must be retried. Queue order is the order in which runners reached the group, not numerical version order. App promotion compares all published stable versions. The updater regenerates stable/alpha manifests from paginated public releases even on historical reruns, and CNB reads the current updater release only after GitHub publication. Docker checks the published release sequence and the current latest image label. Keep fixed/normal Windows builds independent: the executable embeds its product config and updater endpoints; a shared binary is not equivalent. [GitHub concurrency behavior](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)

## Historical replay

Using complete PR file lists, not an API `head_sha` identity assumption:

| Change | Historical | Expected after routing |
|---|---|---|
| #95 | CLI Linux/macOS/Windows packaging 828 job seconds, in addition to docs/quality | Detector, README checks, docs export and both gates. No CLI matrix/package upload. |
| #97 | 2,724 job seconds across matching workflows | Detector, release and registry contracts, lightweight release-note check and both gates. No native matrices or site export. |
| #98, head 8a0ada2 | Three distinct push/PR CLI runs for the same reported head; the main merge tree can differ | dev push has no generic build; baasx-dev push checks the actual push delta; main PR checks the merge delta plus trusted source guard. For the observed release/notes-only change these routes select release/registry contracts and the Markdown check. |

These are expected selections. Runner-seconds removed from a historical matrix are measured baseline resource use; the new wall time and future savings require real PR samples. Full release assembly remains available, so this replay does not claim reduced release time.

## Operating and migrating

1. Add a component rule and positive/negative examples to `scripts/ci/test_impact.py`. Add a job to the plan, its needs in the appropriate named gate, plus relevant merge-context tests. New top-level sources need an explicit owner.
2. Run `python3 -m unittest discover -s scripts/ci`, `bun test tests/frontend/{CiPolicy,ReleaseWorkflows,ReleasePublishing}.test.ts` and the two baasx registry fixture suites. Replay local commits with `python3 scripts/ci/impact.py replay BASE_SHA TESTED_SHA`.
3. Evaluate the candidate on a dev-targeted PR and inspect both old check **names**, source app **GitHub Actions**, and the test merge SHA. A workflow-dispatch run only validates its selected ref; it does not fulfill a protected PR status.
4. No ruleset update is required for compatibility. Keep the confirmed strict dev requirements in place. If maintainers decide to require the quality/docs gates on main, first observe both contexts on an actual promotion PR, add those exact GitHub Actions contexts alongside `Main branch source`, and require an up-to-date branch only if approved. No merge queue was observed; enable `merge_group` and test its merge parents before enabling one.
5. Roll back by reverting the CI commits together (restore the two original gate workflows and triggers). Keep the existing protected names during rollback. Remove only optional newly added main requirements after the original source guard and dev gates are confirmed successful on the test PR. A PR editing its own checker remains a code-review trust decision; protect CI/action changes with existing review policy.

The full job/attempt timing data and API access limits are recorded in [CI-BASELINE.md](CI-BASELINE.md).

## Module workflows

`code-quality.yml` owns change detection and the two required checks. It calls `client-frontend.yml`, `client-native.yml`, `baasx-checks.yml` and `docs-validation.yml` separately. Release workflows keep their product tags and publication locks. `baasx.yml` builds BAASX distribution inputs on six native hosts and uploads twelve archives plus one registry JS bundle. npm and GitHub Packages receive six platform packages and the scoped JS package. The unscoped npm name is pending approval.

## Earlier CI measurements

On 2026-11-13 the router/gate/QQ/CNB/promotion unittest suite passed seven tests. The CI policy, publishing, workflow, registry pack/install and registry double-publish fixture suites passed 30 Bun tests. The pinned compiler `b1007f1177fd402fae67387b8548cae5ae9b5707` built the two JS bundles with `--js-only`; the Node demo ran successfully and no release helper was created. actionlint 1.7.12 passed with one narrowly scoped syntax exception for GitHub’s newer documented `concurrency.queue`; separate tests require `queue: max` and prohibit cancel-in-progress on publication. All YAML files parse and the diff passes `git diff --check`.

The release fixture tests use local archives and simulated API responses. This audit did not publish a release, push a container image, upload an npm package, modify rulesets or send a QQ notification. Whole-platform packaging, Docker publication, CNB mutation and real PR-required-check association remain release or rollout validations.

[GitHub verification run 43419375504](https://github.com/Kiramei/baas-tauri/actions/runs/43419375504) succeeded for implementation commit `5fa289e` using a read-only Code Quality dispatch in contracts mode. The planner took 7 seconds, release contracts 8 seconds, docs gate 4 seconds and quality gate 7 seconds. This is 26 Linux job-seconds and 25 seconds from first job start to final gate completion, with zero macOS/Windows jobs and zero artifacts. Eight unneeded jobs were skipped. This validates the ran/skipped contract and both named gate conclusions on GitHub; rollout must still observe PR check association on an actual merge ref. The follow-up documentation commit records these results.

The registry backfill change was then verified on [implementation commit 0159ced, run 43419926276](https://github.com/Kiramei/baas-tauri/actions/runs/43419926276). All four planned Linux jobs succeeded and the other eight jobs skipped. The run took 30 seconds from creation to completion, including a four-second initial delay, used 26 Linux job-seconds, and produced zero artifacts. The contracts job included the lightweight package/registry fixtures. This second run did not build or publish release packages.

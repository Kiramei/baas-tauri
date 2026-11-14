# GitHub Actions baseline

Collected on 2026-11-13. The implementation baseline is [main at 2b98f61](https://github.com/Kiramei/baas-tauri/tree/2b98f61ae125b149063cc89557620f3e6ac89a25). Seven merged PR final heads provide targeted coverage of different changes. The sample is not a census or a cost forecast.

## Measurements

Seconds below are job durations summed per OS. The jobs column includes skipped records. PR wall time starts at the first PR workflow creation and ends at the last final-attempt PR job completion, including the gap before a rerun. #98 includes two push runs in the resource totals but excludes them from PR wall time. Artifacts are counted once per run across its attempts.

| PR and case | Runs / attempts | Jobs / skipped | Linux s | macOS s | Windows s | PR wall s | Visible artifacts / MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| [#55](https://github.com/Kiramei/baas-tauri/pull/55) WebUI and types | 1 / 1 | 1 / 0 | 978 | 0 | 0 | 982 | 1 / 10.1 |
| [#63](https://github.com/Kiramei/baas-tauri/pull/63) Android release lint | 1 / 2 | 14 / 0 | 1740 | 178 | 345 | 759 | 0 / 0.0 |
| [#91](https://github.com/Kiramei/baas-tauri/pull/91) Shared updater and lockfile | 3 / 3 | 14 / 1 | 1204 | 725 | 608 | 600 | 3 / 125.7 |
| [#94](https://github.com/Kiramei/baas-tauri/pull/94) baasx packaging and runtime | 3 / 3 | 14 / 1 | 1169 | 460 | 672 | 525 | 4 / 126.6 |
| [#95](https://github.com/Kiramei/baas-tauri/pull/95) README and interactive docs | 3 / 3 | 12 / 4 | 851 | 329 | 303 | 652 | 5 / 137.0 |
| [#97](https://github.com/Kiramei/baas-tauri/pull/97) QQ notification and releases | 3 / 3 | 14 / 1 | 1253 | 735 | 736 | 633 | 4 / 126.6 |
| [#98](https://github.com/Kiramei/baas-tauri/pull/98) Promotion and two pushes | 4 / 4 | 10 / 0 | 595 | 674 | 1119 | 356 | 11 / 344.5 |

Across 18 runs and 19 attempts, 72 jobs ran and 7 were skipped. Job time was 7,790 s on Linux, 3,101 s on macOS and 3,783 s on Windows. Median creation-to-start delay across 72 executed jobs was 2 s, with a maximum of 5 s. That delay can include dependencies and runner scheduling. The REST timestamps do not separate them. The API returned 28 visible artifacts totaling 870.6 MiB. Old or deleted artifacts can disappear from this endpoint.

Failed attempts consumed 1892 job-seconds including successful siblings (Linux 1074, macOS 283, Windows 535). Failed jobs alone consumed 357 s. No cancelled job occurred in these final-head samples. Both attempts of #63 run 40660910628 are included. Earlier PR commits are outside this population.

## Historical event replay

| Run | Event / ref | Jobs run | Wall s | First start delay s | Linux s | macOS s | Windows s | Artifacts MiB |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| #95 [baasx CI](https://github.com/Kiramei/baas-tauri/actions/runs/42820569688) | pull_request / codex/baasx-slim-docs | 3 | 334 | 2 | 196 | 329 | 303 | 126.6 |
| #95 [Validate Documentation Export](https://github.com/Kiramei/baas-tauri/actions/runs/42820569667) | pull_request / codex/baasx-slim-docs | 3 | 652 | 2 | 646 | 0 | 0 | 10.4 |
| #95 [Code Quality](https://github.com/Kiramei/baas-tauri/actions/runs/42820569672) | pull_request / codex/baasx-slim-docs | 2 | 13 | 2 | 9 | 0 | 0 | 0.0 |
| #97 [Code Quality](https://github.com/Kiramei/baas-tauri/actions/runs/42848104613) | pull_request / codex/qq-release-notifications | 8 | 633 | 3 | 1056 | 464 | 423 | 0.0 |
| #97 [Validate Documentation Export](https://github.com/Kiramei/baas-tauri/actions/runs/42848104575) | pull_request / codex/qq-release-notifications | 2 | 18 | 3 | 12 | 0 | 0 | 0.0 |
| #97 [baasx CI](https://github.com/Kiramei/baas-tauri/actions/runs/42848104729) | pull_request / codex/qq-release-notifications | 3 | 316 | 3 | 185 | 271 | 313 | 126.6 |
| #98 [baasx CI](https://github.com/Kiramei/baas-tauri/actions/runs/42850124381) | push / baasx-dev | 3 | 396 | 2 | 204 | 180 | 393 | 126.6 |
| #98 [baasx CI](https://github.com/Kiramei/baas-tauri/actions/runs/42850026168) | push / dev | 3 | 374 | 2 | 204 | 194 | 372 | 91.3 |
| #98 [Main Branch Source](https://github.com/Kiramei/baas-tauri/actions/runs/42850140991) | pull_request_target / dev | 1 | 5 | 2 | 3 | 0 | 0 | 0.0 |
| #98 [baasx CI](https://github.com/Kiramei/baas-tauri/actions/runs/42850141494) | pull_request / dev | 3 | 356 | 2 | 184 | 300 | 354 | 126.6 |

The documented dev rules require quality and documentation. The additional CLI matrix on #95 was outside those named gates. Removing that matrix saves runner time while the documentation export still determines merge feedback. On #97 the native matrix ran inside the required quality gate, so selecting a release contract check can also shorten the critical path. Three runs reported head SHA 8a0ada2. Push jobs check out the pushed tree, while a PR default checkout can be a synthetic merge. Head SHA alone does not establish equivalence. The independent main source check validates PR metadata.

## Caches and artifacts

All three Rust-cache steps in the [#95 CLI run](https://github.com/Kiramei/baas-tauri/actions/runs/42820569688) logged hits. The jobs API timed restore at 11 s on Linux, 40 s on macOS and 65 s on Windows. Logs reported 598 MB, 545 MB and 595 MB respectively. Each post step rounded to 0 s. These are measured hits for one CLI run. They do not establish a cold-build comparison, a CQ-wide hit rate or historical savings. Artifact tables use API bytes divided by 1,048,576. Cache size units in this paragraph are copied from the action logs.

The three CLI platform archives and registry bundle for #95 were assigned approximately 90 days of retention. Compare restore, compile and save steps for identical OS, target and profile before broadening compiler caches. Tag caches alone cannot warm unrelated PR refs. A live cache inventory cannot show historical hits or evictions.

## Rulesets and inventory

The [rulesets API](https://api.github.com/repos/Kiramei/baas-tauri/rulesets) returned four repository rulesets. Active “Protect Default” prevents deletion and non-fast-forward updates on the default branch. “Protect main” requires a PR and Main branch source without strict checking. “Protect paused dev” requires a PR, Dev quality gate and Dev documentation gate, with strict checking. These checks specify GitHub Actions integration 15368. “Require C++ integration on dev” is disabled. No active ruleset lists a merge queue. The classic protection endpoints for both dev and main returned HTTP 404 “Branch not protected” with this audit’s credentials. This response does not negate rulesets or describe all possible organization policy. No settings were modified.

The [workflow inventory](https://api.github.com/repos/Kiramei/baas-tauri/actions/workflows) returned the nine baseline YAML files, two older paths (frontend-ui.yml and plugin-workers.yml) and the dynamic Dependabot dependency graph, all marked active. The two absent YAML files do not define triggers in the baseline tree. GitHub controls the dynamic workflow.

## Reproduction

Using the [Actions REST API](https://docs.github.com/en/rest/actions/workflow-runs) for Kiramei/baas-tauri, read pulls/{n} for the final head and actions/runs?head_sha={sha} for workflow IDs. Match PR number when present, otherwise match exact final head, source ref and event. Include dev and baasx-dev pushes for #98. Enumerate attempts from 1 through run_attempt and read actions/runs/{id}/attempts/{a}/jobs. Use per_page=100 until every page is read. Read actions/runs/{id}/artifacts once per run and pulls/{n}/files for the replay paths.

For each executed job, subtract started_at from completed_at in UTC and assign OS from runner labels. Sum overlaps for resource time. For run elapsed time, subtract workflow creation from its last relevant job completion. For first feedback delay, subtract creation from the first job start. An automated feedback or merge gate takes longer than its first job start. Timestamps have one-second precision. No billing rates or cost percentages were applied.

The expected routing replay and maintenance procedure are in [CI.md](CI.md).

# Bilibili shop navigation stall retest

Date: 2026-10-16. Times are China Standard Time (UTC+8). New backend fix: `d0a86a089068766ff53682b501b90bee99857a71`.

## Cause

The game remained on the shop category list. The earlier log recognized Tactical Challenge and then only repeated package checks. In the captured frame, OCR position `(1,233)` produced background anchors `(1,248)`, `(1,283)`, `(206,248)`, and `(206,283)`. The upper anchors landed in the gap between categories, so the white unselected-tab condition failed and the task never clicked.

Same-frame diagnosis confirmed that the original unselected condition was false; moving all four anchors down together by 5–6 pixels made it true. The selected condition stayed false. This was neither a stopped game process nor evidence of a transport mechanism fault.

The debug client was using the actual installation at `D:/Amusement/BAAS_TAURI_BACKEND`, `master@5fd985cdfc95`, rather than the earlier isolated test's repaired branch. That installation lacked the previously added image, asset, gesture, and shop adapters. A current debug frontend does not imply the same backend revision.

## Change and live deployment

- Source edits are restricted to `baas-dev/service/image_compat.py` and its service tests. After the original comparison fails, only the two named CN shop-tab patterns may shift their four anchors together by at most six vertical pixels. Geometry, RGB limits, image scale, and bounds remain checked; other servers retain the original path.
- The actual installation received only `service/image_compat.py`, `service/asset_compat.py`, and installer calls added to its existing `service/injection.py`. Upstream core/task modules, resources, and task options were not overwritten, preserving its newer shop refresh repair.
- Original files were backed up under `<workspace>/.codex_tmp/stall-20261016/installation-backup/`. Deployment did not change configuration files; subsequent task execution normally updated asset caches and schedule times.
- Python was restarted only after confirming the runtime was idle. The repository update workflow was not rerun.

## Live evidence

| Local time | Observed result |
| --- | --- |
| 23:17:08 | Starting Bilibili in the client actually resumed Tactical Challenge shop first. |
| 23:17:18 | OCR found `(1.0,232.5)`, followed by a real click at `(101,262)` and recognition of `temp_shop_selected`. The original blocker was crossed. |
| 23:17:19 | Read 33,938 tactical coins; configured items 7/8 were already unavailable and refresh count was zero. The existing-purchase path exited without a repeated purchase. |
| 23:17–23:19 | Later tasks progressed, including normal 5-1 once and hard H5-1 three times through actual sweep flows. |
| 23:19:34–36 | Logged `all activities finished`, returned home, and read 241/240 AP. No open firing drill and JP-only pass were conditional returns. |
| 23:23–23:24 | Scheduled crafting ran again; all three slots were crafting at 23:24:46, followed by return home at 23:24:50. |

The product's export function saved the initial 506 entries locally as `b-continuation-initial.txt`. Later crafting completion logs, three-second status samples, and independent device images were also checked. Account images, profiles, and runtime logs are not committed.

## Additional asset correction

The installed home credit crop still lost leading digits. Sending the same real 23:20 home frame to the existing local OCR server yielded `8,189,308` with the old crop, `298,189,308` with the corrected crop, and `241/240` AP. The previously validated CN asset adapter was deployed and the idle backend restarted. This was a same-frame diagnostic: no stale image was used to overwrite live asset caches, and no extra gameplay was executed for this check.

## Checks and limits

- `python -m pytest -q tests`: **440 passed, 1 skipped** in 10.46 seconds, with six existing dependency deprecation warnings.
- Image-focused tests: 200 passed. All three deployed service files compiled with the actual Windows Python 3.9 runtime; diff checks passed.
- Unscoped `pytest` also collects the bundled interpreter's standard-library tests and old development scripts, producing collection errors. Acceptance above explicitly targets the repository's `tests` directory; unrelated directories were not modified.
- The client ended connected, with Bilibili showing Start and no active task. Unavailable gameplay was not exercised, and this was not a new full run of all 23 tasks.

The installation still tracks the older `master`; its update channel was not changed. A real repository update can hard-reset `service/injection.py`, so this local deployment does not replace publishing the fix into that channel. The source repair is saved on the repair branch. No version bump or release tag was created.

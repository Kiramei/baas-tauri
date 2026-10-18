# Live execution validation

Date: 2026-10-16. Times below are UTC unless marked otherwise.

**Verdict: the initial version could not complete the configuration. After repairs, all 23 enabled tasks have valid execution or explicit conditional-return evidence.** The scheduler logged `all activities finished` at 09:25:01 and returned home with updated assets at 09:25:04. This required multiple diagnostic stops and resumptions; it was not one uninterrupted successful run, and not every gameplay branch was exercised.

## Version and isolation

| Item | Tested value |
| --- | --- |
| Client execution baseline | `8d35ba250072c55a999032088af2b291b89fed47`, Windows production frontend, version `0.0.8-rc` |
| EXE SHA-256 | `94ecc13cf8cc4c5b3057ad1311f6c8f067e6480b1ed7b5e14c39cc7b358438fb` |
| Backend before repairs | `0cab676755ae74f0d3a4db1e0d5886847a003e35` |
| Backend repair commit | `a9806be8b67be0b1a0ff7bcea7378363db454c94` |
| Runtime | Already running Bilibili client, 1280×720, MuMu 15, Nemu capture/control, shared-memory service transport |
| Configuration | Isolated copy of the user-validated profile; 23 of 26 events enabled; automatic updates disabled for this copy |

The original installation was not overwritten. Source configuration hashes remained unchanged before and after testing:

| File | SHA-256 |
| --- | --- |
| `config.json` | `1be9adfc4255c19c15780b084a3ef939e549790cc401b659c5b2881875b86434` |
| `event.json` | `a883faef47e035ec05fc97f2d4a34c49f44262b5e12c57df103a020022086549` |
| `switch.json` | `f046721430a45cec9577ea95035c3c44bbd5e3a74493860a68f2a37ef778b5b5` |

The observer sampled production-client logs/state about every three seconds and independent device screenshots about every six seconds, cross-checking the actual remote view. Selected navigation tasks were paused after roughly 40 seconds of only package-check logs. Normal/hard tasks received this protection only for the confirmed sweep-only profile; actual combat was excluded. Repeated action logs were also inspected against images. This was a test-tool rule, not a product timeout change.

Local evidence resides in `<workspace>/.codex_tmp/execution-20261016/`: task/state JSONL, device frames, coverage, invalidated completions, final source hashes, failure captures, and remote input before/after images. Profiles, account images, runtime logs, and diagnostic frames are not committed.

## Causes and corrections

The first cafe stall followed the 05:31:59 action. The notification stayed visible while periodic package checks continued. The process and remote connection remained active, but image recognition never reached the next state. Neither absence of an exception nor advancing video counters proved task progress.

Backend edits are restricted to `service/` and its tests. Upstream core/task modules, PyQt UI, and image resources were not changed or cleaned. Task imports remain lazy and installation is idempotent; image/asset changes apply only to CN and delegate other servers to the original implementation.

| Cause | Evidence and correction |
| --- | --- |
| Small layout shifts | Capacity notices, cafe switches/invitation confirmation, sweep confirmations, commission headings, and crafting confirmation moved about 1–5 pixels. Named CN features receive six-pixel local fallbacks with original similarity/RGB gates. The first capacity notice scored 0.1116 at its fixed location versus 0.8909 nearby; it recurred and was automatically dismissed during tactical checkout at 08:13. |
| Gift tray and lessons | Keep the gift title anchor fixed and search only the close glyph within 12 pixels. Two lesson headers moved 8/16 pixels and receive only their own 10/18-pixel windows. Seven actual lessons subsequently completed. |
| Shop columns and tracking | Currency crops clipped later columns; a narrow price strip could identify a different product row. Restore bounded currency detection and column identities, reject incomplete new rows, and track product titles/images/quantities with two-column consensus and gesture bounds. Previously checked top fragments are excluded; lower complete product images establish motion without adding purchase indices. Both shops actually selected and confirmed the configured items. |
| Ignored Nemu duration | The original swipe ignored `duration`. Service scheduling retains the existing curve/scaled coordinates, reaches the endpoint, and releases on errors. A requested 0.7-second touch measured about 0.703 seconds. Shop drags use product images, avoiding the scrollbar's expanded hit region. |
| Quantity-dependent checkout | The eight-product question moved from fixed y=420 to y=147: score 0.02458 versus 0.91102. Only this CN question receives a bounded central search. Eight- and two-product confirmations both passed in the real application. |
| Asset cropping | Actual 999/240 became 9/240, falsely ending normal/hard tasks for insufficient AP. Credit digits were also truncated. Correct CN home/secondary AP and credit crops; actual OCR on identical frames restores complete values. The false completions were invalidated and only those tasks requeued in the test copy; both later completed real sweeps. |
| Incomplete AP reading | A later home transition produced bare `51`; the old parser stored max=-1, displaying an em dash. CN now requires a valid count/max pair, allows two extra fresh-frame attempts, and never overwrites the cache with incomplete data. Existing final warning/fallback and cancellation/error propagation remain. The final real home read was 759/240 with correct UI state. A transitional frame is the inferred cause; the incomplete text and bad cache write are logged facts. |
| Smaller crafting labels | Old phase-one/select-node/start-crafting templates peaked around 0.4–0.49 even globally. Only these named labels receive 0.825/0.85 scale fallbacks near their original button, retaining thresholds. Numbered labels also check digit 1 to reject stages 2/3; bright/grey and different labels are negative controls. All three slots actually entered crafting. |

The first runtime snapshot omitted `window.py`, causing the old notification root lookup to wait indefinitely. Restoring the source marker and notification asset fixed the test fixture. This is not counted as a shipped regression; speculative runtime compensation was reverted. Closing the old preview to its tray was also existing behavior, not an exit deadlock.

## Enabled task results

| Task | Actual coverage and limits |
| --- | --- |
| Restart | Scheduled the next check; no forced game restart tested. |
| Arena | Zero of five tickets; reward collection/exit, without battle. |
| Cafe | Earnings flow, gift tray, and interaction rounds; the later 16:00 local run also completed. |
| Cafe 1 invitation | Cooldown recognized and rescheduled; no invitation. |
| Cafe 2 invitation | Configured starred-student invitation actually completed at 08:12:56. |
| Lesson | Seven tickets and seven completed lessons, ended 06:16:05. |
| Group | Entered the menu; later dismissed sign-in popup. No `GET 10 AP` log, so no new ten-AP claim counted. |
| Daily free power | Explicit CN skip; feature supports JP/Global. |
| Mail | Actual mail reward collection. |
| Daily power | No new claim under current conditions; scheduled 18:00:01 local. |
| Common shop | Eight configured materials automatically confirmed; 132,000 credits spent; completed 08:13:40. |
| Tactical shop | Two configured items automatically confirmed; OCR verifies 45 coins spent. Capacity notice dismissed; final AP placement in inventory/mail not separately checked. |
| Bounty | Two sweeps in each of three areas; `[True, True, True]`, completed 08:22:35. |
| Normal tasks | Invalid AP skip excluded; actual 5-1 sweep once, completed 08:56:21. |
| Hard tasks | Invalid AP skip excluded; actual H5-1 sweep three times, completed 08:56:41. |
| Scrimmage | Two actual sweeps per academy; `[True, True, True]`, completed 08:23:15. |
| Daily commissions | Base defense and item retrieval swept once each, completed 08:57:20. |
| Crafting | Collected old results, resumed one interrupted slot and added two; all three running, rescheduled at 09:23:51. |
| Collect rewards | Actual claims, ending with grey claim-all; completed 09:24:02. |
| MomoTalk | Replied to unread conversations and processed one relationship story. Last conversation used the existing ten-second wait, then rechecked zero unread; completed 09:24:57. |
| Daily minigame | Current activity unsupported; explicit return, gameplay untested. |
| Joint firing drill | Entered the menu; defense was next season and no drill open. Combat untested. |
| Pass | JP-only feature, skipped on Bilibili. |

Disabled total assault, activity sweep, and friend cleanup were not run. No purchase or invitation was manually confirmed. The profile was recopied before the third attempt at 05:49; later runs retained completed state, except the two false AP exits were specifically invalidated and retested.

## Remote control and final checks

- Actual production remote inputs opened/closed help and navigated from home to the account page and back. Four input-to-visible-change samples were about 666, 231, 673, and 489 ms, including an 80-ms touch and roughly 40-ms polling. These are few samples, not a mean or P95.
- The first unresponsive test used an incorrect letterbox mapping in the test tool. Correct mapping passed; it was not treated as a product fault. Settled remote/device screenshots verify return home.
- Five-second playback samples had about 135 presentation callbacks while media time advanced about 2.5 seconds, with inconsistent total/dropped accounting. **No stable-60-FPS claim follows from these counters; playback timing needs separate investigation.** No unvalidated performance changes were mixed into this repair, and no shared-memory mechanism limit was inferred.
- Code inspection shows `RemoteDisplay.tsx` passing the FPS ceiling to `MsePlayer.ts`, after which `h264-converter` synthesizes timestamps at `1/fps` per sample; the Python remote layer only forwards video data. About 30 incoming frames per second with a ceiling of 60 would assign 150 frames 2.5 seconds of media time, consistent with the observation. This remains an unverified explanation, not proof of half-speed visible playback. Follow-up should compare 30/60 settings and capture source-frame arrivals, source PTS, synthesized DTS, and playback waiting events.
- Final backend suite: **356 passed, 1 skipped** in 10.07 seconds. The skip is Unix-only on Windows; six existing dependency deprecation warnings remain. Eleven affected Python files pass 3.9 grammar checks; the real service and suite used Windows Python 3.11.
- All six modified service files in the running snapshot matched the final commit, and staged diff checks passed. Linux, macOS, Android devices, and unavailable/no-ticket combat branches were not exercised.

Testing was normally stopped at 09:26:44; the isolated client remains idle and the original installation unchanged. The Stop button shown after queue completion had represented a scheduler waiting for future tasks. Version stays `0.0.8-rc`; this is a branch commit/push without a release tag.

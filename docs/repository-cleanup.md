# Repository Cleanup

Updated: 2026-10-23. This maintenance record is outside the reader-facing site.

## Preserved Work

- Android preview work is on hold. Its sanitized handoff is committed at
  [`cb8162a3`](https://github.com/Kiramei/baas-tauri/blob/cb8162a3e94510cbbab157acd87e4a5ac8aadd0f/docs/ANDROID_PREVIEW_HANDOFF.md)
  on `fix/android-trusted-display-and-insets`. The runtime changes remain
  separate from `android-dev` and `dev`.
- The React Native worktree has four uncommitted files. It was not switched,
  reset, merged or removed.
- The primary checkout and shared backend checkout were not switched or reset.
  Existing stashes were preserved.
- A verified local Git bundle contains all pre-cleanup refs and complete
  history. The old GUI worktree's ignored IDE settings were archived locally.
  Neither archive is published; both may contain private historical data.

## Removed Refs

Remote branches `fix/linux-adapt` and
`fix/scheduler-localization-and-mobile-ui` were deleted after confirming that
their exact tips are ancestors of `dev` and their PRs are merged.

Thirteen local branches were removed: ten exact-ancestor branches, the redundant
`docs/android-validation` ref identical to `android-dev`, and two old branches
whose only remaining commit is patch-equivalent to a commit in `dev`:
`release/0.0.8-rc` and `fix/detached-process-test-timeout`. No unique patch was
discarded by these deletions. The unused local `main` ref was fast-forwarded
to `origin/main`.

The four obsolete worktrees for Git progress, issue-528 GUI configuration,
multi-source failover and scheduler workflow were unregistered after their
tracked state was confirmed clean and their tips confirmed merged. Three
directories were removed successfully. The issue-528 directory has a long-path
residue after Git's removal failed; further recursive deletion was blocked by
the execution policy, so the residue was left in place. Its tracked history and
IDE settings have backups. No broader recursive cleanup was attempted.

## Kept For Review

- [macOS PR #46](https://github.com/Kiramei/baas-tauri/pull/46) has nine current
  conflicts, including shared-memory transport, platform configuration and
  title-bar handling. Its prior macOS test report predates the current Linux
  integration. It needs an explicit cross-platform integration and regression
  run before merge; it has not been closed or deleted.
- `feat/cpp-integration` retains unique historical commits. It was not merged
  wholesale into the current application or deleted without reconciliation.
- `archive/dev-docs-20260726` and the local archive refs retain historical
  commits. They remain recoverable and are not treated as current docs.
- `fix/uv-live-terminal-output` retains a non-equivalent historical patch even
  though its PR is merged. Its ref remains until that difference is reviewed.
- The primary checkout still uses the merged UI branch. Its local ref was kept
  to avoid switching another task's working directory during cleanup.

## Subsequent Reconciliation

The macOS integration in PR #46 was subsequently merged into `dev` at
`55f11ec6`. The earlier conflict status above describes the initial cleanup
checkpoint.

Remote `docs/dev-refresh` was removed after its documentation changes were
merged. Remote `feat/cpp-integration` was removed separately; its unique history
is retained by the local `archive/feat-cpp-integration` ref. It has not been
merged into the current application.

Remote `archive/dev-docs-20260726` was removed. Its two unique documentation
commits, `62de97e8` and `42cf003b`, were reviewed for PR #49. Useful API material
was rewritten against the current command registry, and Twoslash was restored
with real source imports. Obsolete transport defaults, fixed runtime-version
claims and superseded test matrices were discarded. The local archive ref is
scheduled for removal after PR #49 passes validation and merges. The verified
private bundle preserves the original history.

This list records decisions and limits, not a claim that every historical branch
has been reconciled. Private raw captures, local configuration and credentials
must not be added to this record or a pull request.

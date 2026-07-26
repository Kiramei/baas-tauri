# Issue #528 GUI Configuration Design

**Status:** Approved in conversation on 2026-07-26

**Source:** <https://github.com/pur1fying/blue_archive_auto_script/issues/528>

**Target branch:** `feat/issue-528-gui-config`, based on `dev`

## Goal

Expose the six configuration values requested by Issue #528 in the existing profile configuration UI:

- unrestricted decisive battle formation settings;
- friend-cleanup filter thresholds.

The controls must work in the desktop and Android configuration pages, persist through the existing profile configuration channel, and remain usable with profiles created before these keys existed.

## Scope

### Unrestricted decisive battle

Add a new configuration card and modal for:

| GUI control                  | Configuration key                                                                      | Constraint/default                 |
| ---------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------- |
| Formation method             | `final_restriction_rls_employ_formation_method`                                        | `default`                          |
| Maximum unavailable students | `final_restriction_rls_employ_formation_copy_clear_unit_max_unavailable_student_count` | Integer `0–10`, default `0`        |
| Maximum clear-team refreshes | `final_restriction_rls_employ_formation_copy_clear_unit_max_refresh_count`             | Integer, minimum `0`, default `10` |

Formation method options:

| Display meaning        | Stored value      |
| ---------------------- | ----------------- |
| Use current formation  | `default`         |
| Copy a clear formation | `copy_clear_unit` |

The two copy-clear-formation number fields stay visible but disabled unless the method is `copy_clear_unit`. Their values remain intact while disabled. A short explanation tells users why they are unavailable.

### Friend cleanup

Keep the existing friend whitelist controls and add:

| GUI control                           | Configuration key                            | Constraint/default                  |
| ------------------------------------- | -------------------------------------------- | ----------------------------------- |
| Friend level threshold                | `clear_friend_level_limit`                   | Integer, minimum `-1`, default `-1` |
| Last-login days threshold             | `clear_friend_last_login_time_days`          | Integer, minimum `-1`, default `-1` |
| Previous total-assault rank threshold | `clear_friend_last_total_assault_rank_limit` | Integer, minimum `-1`, default `-1` |

The existing “Friend whitelist” card becomes “Friend cleanup” so the whitelist and all filters for the same cleanup task are managed together. Each threshold clearly states that `-1` disables that condition.

Issue #528 does not define upper bounds for these three values, so the GUI must not invent any.

## Architecture

### Feature registration

Add a `finalRestrictionRls` feature to both configuration-page registries:

- desktop imports the feature panel directly;
- Android lazy-loads the same shared feature panel;
- both pages show the card in the feature-settings group.

The existing `whitelist` feature identifier and component file remain in place to avoid unrelated routing churn. Only its user-facing title and description change to represent the broader friend-cleanup panel.

### Components

Create `FinalRestrictionRlsConfig.tsx` for the unrestricted decisive battle modal.

Extend `WhiteListConfig.tsx` so one draft contains:

- the existing whitelist;
- all three friend-cleanup thresholds.

Both panels follow the existing feature pattern:

1. read `configStore[profileId]`;
2. normalize missing values to the backend defaults;
3. edit a local draft;
4. compute a patch containing only changed keys;
5. call `modify(\`${profileId}::config\`, patch)`;
6. close after saving.

Small pure helpers will own default normalization, conditional enablement, and patch creation. The React panels consume those helpers, and frontend tests exercise the same behavior without duplicating implementation rules in test-only code.

### Types and translations

Add all six keys to `DynamicConfig` with their real string/integer types.

Add typed translation entries for:

- the new card title and description;
- formation method labels;
- both unrestricted decisive battle number fields;
- the conditional-field explanation;
- the renamed friend-cleanup card and description;
- the three friend threshold labels;
- the shared `-1` disabled explanation.

All seven checked locales (`de`, `en`, `fr`, `ja`, `ko`, `ru`, `zh`) receive non-placeholder values. The generated translation-key types and dynamic-key allowlist remain synchronized through the existing i18n tooling.

## Compatibility and Validation

- Missing unrestricted decisive battle values normalize to `default`, `0`, and `10`.
- Missing friend-cleanup values normalize to `-1`.
- The GUI only offers the two backend-supported formation method values.
- Maximum unavailable students is constrained to `0–10`.
- Maximum refresh count is constrained to `0` or greater.
- Friend-cleanup thresholds are constrained to `-1` or greater.
- Disabled copy-clear fields are not reset or silently overwritten.
- No backend protocol, task scheduler, or core Python behavior changes are in scope.

## Testing

Frontend unit tests must first fail on the missing behavior and then verify:

- all missing settings receive the documented defaults;
- copy-clear fields are enabled only for `copy_clear_unit`;
- patch generation emits only changed values;
- switching formation method does not erase copy-clear values;
- friend-cleanup defaults are `-1`;
- whitelist and threshold changes can be saved in the same patch;
- numeric boundaries are represented by the production constraints.

Final verification must include:

- focused frontend tests;
- the complete frontend test suite;
- i18n validation across all seven locales;
- ESLint;
- TypeScript and Tauri-mode Vite build;
- Prettier and `git diff --check`;
- a rendered browser check of both configuration modals at desktop and narrow/Android widths.

## Out of Scope

- Changes to the Python implementation introduced by PR #449 or Issue #423.
- New task scheduling controls.
- New friend-cleanup criteria beyond the three keys in Issue #528.
- Redesigning unrelated configuration cards or the shared modal system.

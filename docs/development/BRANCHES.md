# Branch promotion and synchronization

Feature work enters `dev` through a pull request using **Squash and merge**. Promote `dev` to `main` through a pull request using **Create a merge commit**; the existing Main branch source check continues to require this repository's `dev` branch. After promotion, advance `dev` to the resulting `main` commit with a fast-forward ref update. This restores identical branch tips without adding a second merge commit.

The initial history reset that aligns the development branch with Main is a one-time maintenance exception. It does not authorize future force pushes, branch deletion, or automatic recovery by overwriting concurrent work.

## Repository rules

Keep merge commits and squash merges enabled in repository settings. Configure the matching branch rulesets as follows:

| Target | Rules | Bypass |
| --- | --- | --- |
| `main` | Require a PR; `allowed_merge_methods: ["merge"]`; retain Main branch source and existing integrity rules | No branch-sync App bypass |
| `dev` integrity | Block deletion and non-fast-forward updates | None, including the branch-sync App |
| `dev` PR and CI | Require a PR; `allowed_merge_methods: ["squash"]`; retain Dev quality gate and Dev documentation gate with strict checks | Only the dedicated branch-sync App: `actor_type: Integration`, its App ID, `bypass_mode: always` |

Place Dev integrity in a separate ruleset before granting the App bypass to the Dev PR and CI ruleset. Bypass applies to every rule in its ruleset; the separate integrity rules continue to apply to the App. Do not enable linear history on Dev: the legitimate Main merge commit must enter Dev during synchronization. GitHub documents [allowed merge methods and bypass actors](https://docs.github.com/en/rest/repos/rules#update-a-repository-ruleset) and [ruleset layering](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets#about-rule-layering).

## App and workflow setup

Install a dedicated GitHub App for this repository only, with repository **Contents: write** and **Workflows: write** permissions. It does not need Administration permission. Create the `branch-sync` GitHub environment with **Selected branches and tags** allowing only the **main branch**, with no tag rules. The synchronization job uses that environment and also requires the `refs/heads/main` workflow ref, including manual dispatch. Add these secrets to that environment, rather than repository-wide Actions secrets:

- `BRANCH_SYNC_APP_ID`: the GitHub App ID.
- `BRANCH_SYNC_APP_PRIVATE_KEY`: the App's private key.

The workflow's `GITHUB_TOKEN` remains `contents: read`. Only the App installation token performs the Dev ref update. Its bypass does not apply to Main or the Dev integrity ruleset.

Reuse **Source Dispatch**: a push to `main` starts branch synchronization; manual recovery selects the `main` workflow ref and `operation: branches`. Do not also subscribe to PR `closed` events for the same promotion. Branch synchronization creates no release, tag, or package.

```sh
gh workflow run source-dispatch.yml --ref main -f operation=branches
```

Promote Main as a user or with an App token. A merge performed using a workflow's `GITHUB_TOKEN` does not start the following push workflow. The App's Dev update does not repeat product builds: Code Quality runs for pull requests and manual dispatches. Source Dispatch synchronizes branches from Main. See [GITHUB_TOKEN event behavior](https://docs.github.com/en/actions/concepts/security/github_token#when-github_token-triggers-workflow-runs).

## Synchronization checks and recovery

- Identical Main and Dev tips are a no-op. A stale Main event must not update Dev.
- The current Main commit must have exactly two parents, with its second parent equal to the current Dev tip. Its tree must equal that Dev commit's tree. A different parent or tree requires review instead of automatic synchronization.
- Serialize synchronization and recheck the remote refs before updating. Reject concurrent branch movement; never reset a newer Dev commit to the promoted snapshot.
- Update only `refs/heads/dev` with `force: false`. Each API request has a 20-second timeout. An API failure must remain a failure; do not retry the write, fall back to an administrator token, or weaken rules. The [Git refs API](https://docs.github.com/en/rest/git/refs#update-a-reference) guarantees a fast-forward update when force is false.

If a feature merges into Dev while promotion is finishing, leave that work intact and resolve the branch state manually. Inspect both branch tips and the promotion commit, preserve concurrent commits, and review the next promotion before resuming synchronization. A failed or skipped synchronization is not permission to repeat the one-time history reset.

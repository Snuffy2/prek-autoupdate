# prek-autoupdate

A Linux Node 24 GitHub Action that runs `prek auto-update`, opens or updates one
workflow-owned pull request, and removes stale workflow-owned pull requests and
branches.

## Usage

Create `.github/workflows/prek_autoupdate.yml` in the repository whose hooks
should be updated:

```yaml
name: prek Autoupdate

on:
  schedule:
    - cron: "0 2 * * *"
  push:
    branches:
      - main
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

concurrency:
  group: prek-autoupdate-${{ github.repository }}
  cancel-in-progress: false

jobs:
  prek-autoupdate:
    runs-on: ubuntu-24.04
    steps:
      - name: Checkout repository
        uses: actions/checkout@v7
        with:
          persist-credentials: false

      - name: Update prek hooks
        id: prek-autoupdate
        uses: Snuffy2/prek-autoupdate@v2
        with:
          update-day: "1"
```

The checkout is required. It must be the repository being updated, on its
branch, with `persist-credentials: false`; the action refuses a dirty checkout
or an `origin` that does not match the workflow repository.

Run the workflow daily so cleanup runs every night. Keep the `push` trigger so
changes landing on `main` reconcile an existing update PR. The concurrency group
prevents two runs from mutating the same branch at once without cancelling an
in-flight cleanup.

## Event behavior

| Event                            | Run `prek auto-update` | Reconcile PRs and branches                                                            |
| -------------------------------- | ---------------------- | ------------------------------------------------------------------------------------- |
| Daily `schedule` on `update-day` | Yes                    | Yes                                                                                   |
| Daily `schedule` on another day  | No                     | Yes                                                                                   |
| `workflow_dispatch`              | Yes                    | Yes                                                                                   |
| `push` to `main`                 | No                     | Yes; close the owned PR only when its paths are already identical to the current base |

The action supports Linux runners on x64 and arm64. It is not supported on
Windows or macOS runners.

Each action release pins a verified `prek` release for reproducible updates.
Version 2.0.0 uses `prek` 0.4.11 and verifies both the official archive and the
extracted executable before running it, including executables restored from the
runner tool cache.

## Inputs

| Input            | Default                    | Description                                                                                                        |
| ---------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `token`          | `${{ github.token }}`      | GitHub token used to push the update branch and manage pull requests.                                              |
| `cooldown-days`  | `"7"`                      | Value passed to `prek auto-update --cooldown-days`.                                                                |
| `update-day`     | `"1"`                      | UTC day of week for scheduled updates, where `0` is Sunday and `6` is Saturday.                                    |
| `update-branch`  | `chore/prek-updates`       | Branch used for update pull requests.                                                                              |
| `branch-prefix`  | `chore/prek-updates`       | Prefix considered owned by cleanup.                                                                                |
| `label`          | `dependencies`             | Pull-request label and cleanup ownership signal.                                                                   |
| `commit-message` | `chore: update prek hooks` | Update commit message.                                                                                             |
| `pr-title`       | `Bump prek Hooks`          | Update pull-request title.                                                                                         |
| `add-paths`      | auto-detect                | Newline-separated git pathspecs to commit. Empty requires exactly one of `prek.toml` or `.pre-commit-config.yaml`. |

## Output

`pull-request-number` is the created or updated pull-request number. It is empty
when the run does not leave an update pull request:

```yaml
- name: Report update PR
  if: steps.prek-autoupdate.outputs.pull-request-number != ''
  run: echo "PR #${{ steps.prek-autoupdate.outputs.pull-request-number }}"
```

## Token and permissions

The normal path uses the job's `GITHUB_TOKEN` and needs only:

```yaml
permissions:
  contents: write
  pull-requests: write
```

GitHub may prevent events from a `GITHUB_TOKEN`-created pull request from
starting additional workflows. If downstream CI must run for the generated PR,
pass a GitHub App installation token or a fine-grained PAT as `token`. Limit it
to this repository with read/write **Contents** and **Pull requests** access.
For a classic PAT, the equivalent repository scope is `repo`. Store the token as
an Actions secret and keep one identity consistent across PR creation, ownership
checks, and branch cleanup; changing identities can make an existing PR
intentionally fail ownership proof.

```yaml
with:
  token: ${{ secrets.PREK_AUTOUPDATE_TOKEN }}
```

No `actions: write` permission is required.

## Releases

Use the moving major tag `v2` for stable v2 updates. Published, non-prerelease
`v2.x.y` releases move `v2` to the released commit; immutable release tags are
not rewritten.

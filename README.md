# prek-autoupdate

`prek-autoupdate` is a GitHub Action that runs `prek auto-update` for you. It
keeps one pull request for the resulting hook updates, then cleans up older
action-owned pull requests and branches when they are no longer needed.

## Get started

Add this workflow as `.github/workflows/prek_autoupdate.yml` in the repository
whose hooks you want to update:

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
    runs-on: ubuntu-latest
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

GitHub enables manual `workflow_dispatch` runs only after this file exists on
the repository's default branch.

Schedule the workflow every day. The action decides which scheduled day actually
runs `prek auto-update` from `update-day`; cleanup still runs on the other days.
Keep the `push` trigger for `main`: it is a cleanup-only run that reconciles an
existing action-owned update PR after changes land. It does not run
`prek auto-update`, open a PR, or update a PR. The concurrency setting lets a
running cleanup finish instead of cancelling it when another run starts.

## What each event does

| Event                            | Run `prek auto-update` | Clean up action-owned PRs and branches                                                       |
| -------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------- |
| Daily `schedule` on `update-day` | Yes                    | Yes                                                                                          |
| Daily `schedule` on another day  | No                     | Yes                                                                                          |
| `workflow_dispatch`              | Yes                    | Yes                                                                                          |
| `push` to `main`                 | No                     | Yes. It closes an owned update PR only when its files already match the current base branch. |

Cleanup is deliberately conservative. Before the action changes a pull request
or deletes a branch, it checks ownership details such as the configured branch
prefix, repository, base branch, label, author, and its own PR body marker.

## Requirements and limits

Use a Linux x64 or arm64 runner. The action works on GitHub.com and GitHub
Enterprise Server, including self-hosted Linux runners with system Git in
`/usr/local/bin` or the standard Nix/NixOS system profiles. Windows and macOS
runners are not supported.

Each release uses a pinned `prek` release. Version 2.0.0 uses `prek` 0.4.11 and
verifies the official archive and extracted executable before running it. It
also verifies an executable restored from the runner tool cache.

## Inputs

You can usually use the defaults. Only add a `with:` value when the default does
not match your repository.

| Input            | Default                    | What it controls                                                                                                                                |
| ---------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `token`          | `${{ github.token }}`      | The job's GitHub token, used to push the update branch and manage pull requests.                                                                |
| `author-login`   | `github-actions[bot]`      | The PR author identity used for ownership checks if GitHub cannot report the token's authenticated login.                                       |
| `cooldown-days`  | `"7"`                      | Passed to `prek auto-update --cooldown-days`.                                                                                                   |
| `update-day`     | `"1"`                      | UTC day for scheduled updates: `0` is Sunday and `6` is Saturday.                                                                               |
| `update-branch`  | `chore/prek-updates`       | The branch for the update pull request.                                                                                                         |
| `branch-prefix`  | `chore/prek-updates`       | The branch prefix that cleanup treats as action-owned.                                                                                          |
| `label`          | `dependencies`             | An existing repository label applied to the update PR and used to prove ownership during cleanup.                                               |
| `commit-message` | `chore: update prek hooks` | The update commit message.                                                                                                                      |
| `pr-title`       | `Bump prek Hooks`          | The update pull-request title.                                                                                                                  |
| `add-paths`      | auto-detect                | Newline-separated repository-relative paths to commit. When blank, the action requires exactly one of `prek.toml` or `.pre-commit-config.yaml`. |

## Output

`pull-request-number` is set only when this run creates or updates an update PR.
It is empty for cleanup-only and no-update runs, even when an action-owned
update PR remains open. Check for a non-empty value before using it:

```yaml
- name: Report update PR
  if: steps.prek-autoupdate.outputs.pull-request-number != ''
  run: echo "PR #${{ steps.prek-autoupdate.outputs.pull-request-number }}"
```

## Permissions

The normal setup uses the job's `GITHUB_TOKEN`. It needs only these permissions:

```yaml
permissions:
  contents: write
  pull-requests: write
```

Keep the default token identity consistent for the update PR and later cleanup
runs, because cleanup uses that identity as part of its ownership proof.

If a generated update PR must trigger downstream CI, provide a GitHub App
installation token or a personal access token (PAT) through `token` instead.
Give that token repository **Contents: read and write** and **Pull requests:
read and write** permissions; it needs no `actions: write` permission. Store it
as a repository secret, then pass it to the action. With a GitHub App
installation token, also set its bot login before the action creates a PR:

```yaml
with:
  token: ${{ secrets.PREK_AUTOUPDATE_TOKEN }}
  author-login: <app-slug>[bot]
```

Keep the same `author-login` value for scheduled, manual, and push-triggered
cleanup runs. For a PAT, the action normally discovers the token owner's GitHub
login automatically, so `author-login` is not required.

## Releases

Use the moving major tag `v2` for stable v2 updates. Each published,
non-prerelease `v2.x.y` release moves `v2` to that release commit. Immutable
release tags are never rewritten.

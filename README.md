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
    if: github.event.repository.fork == false
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
the repository's default branch. The job skips forked repositories, preventing
forks from creating their own automated maintenance pull requests.

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

Each run resolves the latest stable `prek` release from the official GitHub
release URL. The lookup uses bounded retries and the run fails if it cannot
resolve a release: because the runner tool cache is keyed by the resolved
version, it cannot supply a fallback version. The action downloads that
version's archive and published SHA-256 checksum, or restores the versioned
archive from the runner tool cache. It verifies the archive against the official
checksum every time before extracting and running the executable. This detects
download corruption or modification of a cached archive, but the checksum is
published by the same upstream release and is not an independent trust anchor.
Each compatible latest upstream `prek` release with a numeric `vN.N.N` tag and
the expected Linux archive/checksum layout is trusted automatically, so a new
`prek-autoupdate` release is not required to pick it up. The workflow log
reports the exact `prek-autoupdate` release and resolved `prek` release
immediately before each is run.

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

Use the moving major tag for stable updates. Each published, non-prerelease
`v<major>.<minor>.<patch>` release creates or moves its corresponding `v<major>`
tag to that release commit. For example, publishing `v3.1.0` creates or moves
`v3`.

The release workflow validates the published source, prepares the package
metadata and bundled Action, then atomically commits those files and retargets
the newly published point tag to the final release commit. Because GitHub
publishes the point tag before this workflow runs, an exact
`v<major>.<minor>.<patch>` tag may briefly resolve first to the original tagged
commit and then to the final release commit. Later releases do not retarget it
again. Wait for the release workflow to finish before recording an exact release
ref; use the final commit SHA when a permanently immutable pin is required.

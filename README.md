# prek-autoupdate

Reusable GitHub Actions workflow for opening and maintaining `prek auto-update` pull requests.

## What It Does

- Runs `prek auto-update --cooldown-days <days>`.
- Opens or updates one PR on `chore/prek-updates`.
- Closes duplicate stale workflow-owned PRs.
- Deletes stale and merged workflow-owned update branches.
- Optionally dispatches named workflows on the update branch using the repository `GITHUB_TOKEN`.

## Quick Start

Create `.github/workflows/prek_autoupdate.yml` in the consuming repository:

```yaml
name: prek Autoupdate

on:
  schedule:
    - cron: "0 2 * * *"
  workflow_dispatch:

jobs:
  prek-autoupdate:
    uses: Snuffy2/prek-autoupdate/.github/workflows/prek_autoupdate.yml@v1
    permissions:
      contents: write
      pull-requests: write
```

This runs `prek auto-update` on the caller workflow's schedule or when manually dispatched.
Major version tags such as `v1` are updated on release to point at the latest release in that major series.

## Run CI on the Update Branch

GitHub limits what events can be triggered by the repository `GITHUB_TOKEN`. PRs created by automation may require manual workflow approval, and fully automatic PR workflow runs without that approval require a GitHub App token or PAT.

The token-only workaround is to dispatch named workflows on the update branch with `workflow_dispatch`. Add `actions: write` and list the workflows in `dispatch-workflows`:

```yaml
jobs:
  prek-autoupdate:
    uses: Snuffy2/prek-autoupdate/.github/workflows/prek_autoupdate.yml@v1
    permissions:
      contents: write
      pull-requests: write
      actions: write
    with:
      dispatch-workflows: |
        ci.yml
        tests.yml
```

Each listed workflow must support manual dispatch:

```yaml
on:
  pull_request:
  workflow_dispatch:
```

GitHub only dispatches workflows that already exist on the repository default branch, so add `workflow_dispatch` before relying on `dispatch-workflows` for a new workflow.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `cooldown-days` | `"7"` | Value passed to `prek auto-update --cooldown-days`. |
| `update-branch` | `chore/prek-updates` | Branch used for update PRs. |
| `branch-prefix` | `chore/prek-updates` | Prefix considered owned by cleanup. |
| `label` | `dependencies` | PR label used for generated PRs and cleanup ownership checks. |
| `commit-message` | `chore: update prek hooks` | Commit message for update commits. |
| `pr-title` | `Bump prek Hooks` | Pull request title. |
| `add-paths` | auto-detect | Newline-separated paths the PR action may commit. By default, the workflow uses the one existing `prek` config file: `prek.toml` or `.pre-commit-config.yaml`. |
| `dispatch-workflows` | empty | Newline-separated workflow names, filenames, or IDs to run on the update branch with `workflow_dispatch`. |

# prek-autoupdate

Reusable GitHub Actions workflow for opening and maintaining `prek auto-update` pull requests.

## What It Does

- Runs `prek auto-update --cooldown-days <days>`.
- Opens or updates one PR on `chore/prek-updates`.
- Closes duplicate stale workflow-owned PRs.
- Deletes stale and merged workflow-owned update branches.
- Optionally dispatches named workflows on the update branch using the repository `GITHUB_TOKEN`.
- Removes the duplicate approval-required runs for successfully dispatched workflows.

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

Run the caller workflow daily so stale PR and branch cleanup happens every night. `prek auto-update` only runs on `update-day`, or when the workflow is manually dispatched.
This normal path does not need `actions: write`.
Major version tags such as `v1` are updated on release to point at the latest release in that major series.

## Run CI on the Update Branch

GitHub creates approval-required `pull_request` runs when this workflow opens or updates a PR with the repository `GITHUB_TOKEN`.

The token-only workaround dispatches named workflows on the update branch with `workflow_dispatch`, then deletes the duplicate approval-required runs for those same workflow IDs, PR number, and head commit. The dispatched runs remain as the PR's checks, without requiring a PAT or GitHub App.

When setting `dispatch-workflows`, the caller job must also grant `actions: write`.

Example caller workflow:

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
      actions: write
    with:
      update-day: "1"
      dispatch-workflows: |
        ci.yml
        tests.yml
```

Without `actions: write`, GitHub can reject the reusable workflow call before it reaches the hook update job.

Each listed workflow must support manual dispatch, and its jobs and steps must support the `workflow_dispatch` event:

```yaml
on:
  pull_request:
  workflow_dispatch:
```

GitHub only dispatches workflows that already exist on the repository default branch, so add `workflow_dispatch` before relying on `dispatch-workflows` for a new workflow.

The workflow removes only `action_required` runs that match the configured workflow, generated PR number, and exact PR head SHA. If dispatching fails, the approval-required runs remain available for manual approval.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `cooldown-days` | `"7"` | Value passed to `prek auto-update --cooldown-days`. |
| `update-day` | `"1"` | UTC day of week to run `prek auto-update`, where `0` is Sunday and `6` is Saturday. Manual runs always check for updates. Schedule callers daily so cleanup can run every night. |
| `update-branch` | `chore/prek-updates` | Branch used for update PRs. |
| `branch-prefix` | `chore/prek-updates` | Prefix considered owned by cleanup. |
| `label` | `dependencies` | PR label used for generated PRs and cleanup ownership checks. |
| `commit-message` | `chore: update prek hooks` | Commit message for update commits. |
| `pr-title` | `Bump prek Hooks` | Pull request title. |
| `add-paths` | auto-detect | Newline-separated paths the PR action may commit. By default, the workflow uses the one existing `prek` config file: `prek.toml` or `.pre-commit-config.yaml`. |
| `dispatch-workflows` | empty | Newline-separated workflow names, filenames, or IDs to run on the update branch with `workflow_dispatch`; matching approval-required runs are removed after dispatch. Requires caller permission `actions: write` when set. |

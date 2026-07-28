# prek-autoupdate

Reusable GitHub Actions workflow for opening and maintaining `prek auto-update` pull requests.

## What It Does

- Runs `prek auto-update --cooldown-days <days>`.
- Opens or updates one PR on `chore/prek-updates`.
- Checks the existing update PR after pushes to `main`, closing it when its changes are
  already present on the current base.
- Closes duplicate stale workflow-owned PRs.
- Deletes stale and merged workflow-owned update branches.

## Quick Start

Create `.github/workflows/prek_autoupdate.yml` in the consuming repository:

```yaml
name: prek Autoupdate

on:
  schedule:
    - cron: "0 2 * * *"
  push:
    branches:
      - main
  workflow_dispatch:

jobs:
  prek-autoupdate:
    uses: Snuffy2/prek-autoupdate/.github/workflows/prek_autoupdate.yml@v1
    permissions:
      contents: write
      pull-requests: write
    with:
      update-day: "1"
```

Keep the `push` trigger so changes landing on `main` check whether an existing workflow-owned update PR still contributes unique file content. This covers upstream syncs and similar workflows that may make the PR unnecessary. Push runs do not call `prek auto-update`, create a PR, or update a still-needed PR; cleanup closes a PR only when GitHub reports no changed files or every path affected by the PR already matches the current base, then safely deletes its branch.

Run the caller workflow daily so stale PR and branch cleanup happens every night. Scheduled runs only call `prek auto-update` on `update-day`, and manual runs always check for updates.
This normal path does not need `actions: write`.
Major version tags such as `v1` are updated on release to point at the latest release in that major series.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `cooldown-days` | `"7"` | Value passed to `prek auto-update --cooldown-days`. |
| `update-day` | `"1"` | UTC day of week for scheduled `prek auto-update`, where `0` is Sunday and `6` is Saturday. Manual runs always check for updates. Schedule callers daily so cleanup can run every night. |
| `update-branch` | `chore/prek-updates` | Branch used for update PRs. |
| `branch-prefix` | `chore/prek-updates` | Prefix considered owned by cleanup. |
| `label` | `dependencies` | PR label used for generated PRs and cleanup ownership checks. |
| `commit-message` | `chore: update prek hooks` | Commit message for update commits. |
| `pr-title` | `Bump prek Hooks` | Pull request title. |
| `add-paths` | auto-detect | Newline-separated paths the PR action may commit. By default, the workflow uses the one existing `prek` config file: `prek.toml` or `.pre-commit-config.yaml`. |

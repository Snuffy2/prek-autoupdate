# prek-autoupdate

Reusable GitHub Actions workflow for opening and maintaining `prek auto-update` pull requests.

## What It Does

- Runs `prek auto-update --cooldown-days <days>`.
- Opens or updates one PR on `chore/prek-updates`.
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

Run the caller workflow daily so stale PR and branch cleanup happens every night. `prek auto-update` only runs on `update-day`, or when the workflow is manually dispatched.
This normal path does not need `actions: write`.
Major version tags such as `v1` are updated on release to point at the latest release in that major series.

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

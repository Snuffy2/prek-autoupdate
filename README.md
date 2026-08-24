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

| Input            | Default                    | What it controls                                                                                                                                 |
| ---------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `token`          | `${{ github.token }}`      | Credential used to push the update branch and manage pull requests. See [Authentication and permissions](#authentication-and-permissions).       |
| `auto-merge`     | `false`                    | With a PAT, requests squash auto-merge for the exact pull-request revision published by the action. See [Automatic merging](#automatic-merging). |
| `author-login`   | `github-actions[bot]`      | Fallback PR-author login used only when GitHub cannot identify the token's user. See [When to set `author-login`](#when-to-set-author-login).    |
| `cooldown-days`  | `"7"`                      | Passed to `prek auto-update --cooldown-days`.                                                                                                    |
| `update-day`     | `"1"`                      | UTC day for scheduled updates: `0` is Sunday and `6` is Saturday.                                                                                |
| `update-branch`  | `chore/prek-updates`       | The branch for the update pull request.                                                                                                          |
| `branch-prefix`  | `chore/prek-updates`       | The branch prefix that cleanup treats as action-owned.                                                                                           |
| `label`          | `dependencies`             | An existing repository label applied to the update PR and used to prove ownership during cleanup.                                                |
| `commit-message` | `chore: update prek hooks` | The update commit message.                                                                                                                       |
| `pr-title`       | `Bump prek Hooks`          | The update pull-request title.                                                                                                                   |
| `add-paths`      | auto-detect                | Newline-separated repository-relative paths to commit. When blank, the action requires exactly one of `prek.toml` or `.pre-commit-config.yaml`.  |

## Output

`pull-request-number` is set only when this run creates or updates an update PR.
It is empty for cleanup-only and no-update runs, even when an action-owned
update PR remains open. Check for a non-empty value before using it:

```yaml
- name: Report update PR
  if: steps.prek-autoupdate.outputs.pull-request-number != ''
  run: echo "PR #${{ steps.prek-autoupdate.outputs.pull-request-number }}"
```

## Authentication and permissions

Choose one of the two primary setups: the built-in `GITHUB_TOKEN`, or a PAT.
Workflow permissions and PAT permissions are separate settings:

- The workflow's YAML `permissions:` block configures only that job's
  `GITHUB_TOKEN`.
- A PAT passed through `token` keeps the scopes or repository permissions
  configured when the PAT was created. The YAML `permissions:` block does not
  add permissions to the PAT.

### Default `GITHUB_TOKEN`

If `token` is omitted, the action uses the job's `GITHUB_TOKEN`. Grant that
generated token these workflow permissions in the workflow YAML:

```yaml
permissions:
  contents: write
  pull-requests: write
```

`contents: write` lets the action push and delete its update branch.
`pull-requests: write` lets it create, update, and close its pull request. The
workflow does not need `actions: write`.

This is the simplest setup, but pull requests created with `GITHUB_TOKEN` do not
trigger most downstream workflow runs. The action also does not use
`GITHUB_TOKEN` for its built-in auto-merge option. Omit `author-login`; its
default value, `github-actions[bot]`, is correct.

### PAT supplied through `token`

Use a PAT when the generated pull request must trigger downstream CI or when
using the built-in auto-merge option. Store it as an Actions secret and pass the
secret through the action's `token` input:

```yaml
- name: Checkout repository
  uses: actions/checkout@v7
  with:
    persist-credentials: false

- name: Update prek hooks
  uses: Snuffy2/prek-autoupdate@v2
  with:
    token: ${{ secrets.PREK_AUTOUPDATE_TOKEN }}
```

Because the PAT performs the writes, the job's own `GITHUB_TOKEN` needs only
`contents: read` for `actions/checkout`:

```yaml
permissions:
  contents: read
```

Configure the PAT itself using one of the following sections.

#### Classic PAT scopes

A classic PAT is the recommended compatibility-first credential for built-in
auto-merge. Create it under **Settings > Developer settings > Personal access
tokens > Tokens (classic)** for a dedicated automation account that already has
write access to the target repository. A scope cannot grant repository access
that the account itself does not have.

Select the narrowest applicable classic PAT scope:

- For public repositories only, select `public_repo`.
- For a private or internal repository, select `repo`. GitHub defines `repo` as
  a broad scope covering public and private repositories, so a dedicated
  automation account limits its exposure.

Do not select the classic PAT scopes `workflow`, `admin:org`, or any package
scope; this action does not need them. Set an expiration, rotate the PAT before
it expires, and store it in an Actions secret such as
`PREK_AUTOUPDATE_TOKEN`—never directly in workflow YAML. See GitHub's
[classic PAT scope reference](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps).

If the repository belongs to an organization that uses SAML single sign-on,
authorize the classic PAT for that organization after creating it. An
organization can also prohibit classic PAT access entirely. See GitHub's
[PAT management guidance](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).

Omit `author-login`; the action discovers the PAT owner's login.

#### Fine-grained PAT permissions

A fine-grained PAT is a narrower alternative when the organization and target
repository support it. Select the target repository and grant these repository
permissions:

- **Contents: read and write**
- **Pull requests: read and write**

GitHub adds **Metadata: read** automatically. No other repository or account
permissions are needed. Omit `author-login`; the action discovers the PAT
owner's login.

### When to set `author-login`

`author-login` is only a fallback used to prove that an update PR belongs to
this action. It does not select the credential, change the PR author, or grant
either workflow or credential permissions.

- **Default `GITHUB_TOKEN`:** omit `author-login`. Its default value,
  `github-actions[bot]`, is already correct. This remains true if the workflow
  passes `${{ github.token }}` explicitly through `token`.
- **Classic or fine-grained PAT:** omit `author-login`. The action discovers the
  PAT owner's login from GitHub and uses that value, even if `author-login` was
  also supplied.

If a token cannot identify a user and its PR author is not
`github-actions[bot]`, `author-login` is required and must exactly match the PR
author. Use the same value in scheduled, manual, and push-triggered cleanup
runs; a different value causes the ownership checks to fail closed rather than
modify a PR owned by another identity.

As an advanced compatibility case, an organization that already issues GitHub
App installation tokens may pass one through `token`. Configure the App itself
with repository **Contents: read and write** and **Pull requests: read and
write**, and set `author-login` to its exact `<app-slug>[bot]` login. The App
does not need the **Actions** repository permission, and its installation token
cannot use this action's built-in auto-merge option.

## Automatic merging

Set `auto-merge: true` to have the action request a squash merge after it
creates or updates and verifies its owned pull request:

```yaml
- name: Checkout repository
  uses: actions/checkout@v7
  with:
    persist-credentials: false

- name: Update prek hooks
  uses: Snuffy2/prek-autoupdate@v2
  with:
    token: ${{ secrets.PREK_AUTOUPDATE_TOKEN }}
    auto-merge: true
```

This option is disabled by default and requires a PAT supplied through `token`.
The action skips the auto-merge request for every other credential type.

With a confirmed PAT, the action binds the request to the exact head commit that
it published. GitHub, rather than the action, waits for every required review
and status check and then performs a squash merge. A separate
pull-request-triggered auto-merge workflow is not required.

Complete all of these prerequisites before enabling the option:

1. In **Settings > General > Pull Requests**, enable **Allow auto-merge** and
   **Allow squash merging** for the repository.
2. Create a PAT for a dedicated automation identity. Configure either the
   [classic PAT scopes](#classic-pat-scopes) or
   [fine-grained PAT permissions](#fine-grained-pat-permissions), store the PAT
   as a repository secret such as `PREK_AUTOUPDATE_TOKEN`, and pass it through
   `token`. The action does not attempt built-in auto-merge without a PAT.
3. Create an active branch ruleset targeting the default branch. Enable
   **Require a pull request before merging** and **Require status checks to pass
   before merging**, then select every CI check that must pass. Do not give the
   PAT owner a ruleset bypass if CI must remain mandatory.

A branch ruleset makes the selected CI checks merge requirements. Auto-merge
then waits instead of merging the generated PR before CI has passed. Strict
status checks can additionally require the PR branch to be current with the base
branch, while loose checks allow it to merge after the selected checks pass on
its existing head. See GitHub's documentation for
[creating rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository)
and the available
[ruleset status-check rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-status-checks-to-pass-before-merging).

If auto-merge is disabled at the repository level, squash merges are not
allowed, the token lacks permission, or no merge requirement is holding the PR,
GitHub can reject the request and the action run fails without closing the
otherwise valid update pull request.

## Releases

Use the moving major tag for stable updates. Each manually dispatched
`v<major>.<minor>.<patch>` release creates or moves its corresponding `v<major>`
tag to that release commit. For example, dispatching `v3.1.0` creates or moves
`v3`.

Run the Release workflow from the default branch and supply the stable release
tag. The workflow validates that source, prepares the package metadata and
bundled Action, then atomically commits those files, creates the new point tag
at the final release commit, and publishes the GitHub Release. The exact
`v<major>.<minor>.<patch>` tag is created at the final release commit and is not
retargeted by later releases. Wait for the release workflow to finish before
recording an exact release ref; use the final commit SHA when a permanently
immutable pin is required.

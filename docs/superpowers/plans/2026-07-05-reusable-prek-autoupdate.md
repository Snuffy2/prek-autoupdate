# Reusable prek Autoupdate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `Snuffy2/prek-autoupdate` as the single maintained reusable workflow for weekly `prek auto-update`, stale PR/branch cleanup, and optional token-only workflow dispatch on created update PRs.

**Architecture:** Keep the caller workflow tiny: schedule plus a single `jobs.<job_id>.uses` call into this repo. The reusable workflow checks out the target repo into `target/`, checks out this tooling repo into `tooling/`, runs `prek auto-update`, opens or updates the PR with `peter-evans/create-pull-request`, runs the central cleanup script, and optionally dispatches named workflows on the update branch using `GITHUB_TOKEN`. Normal `pull_request` workflow auto-approval cannot be forced with only `GITHUB_TOKEN`; GitHub documents that avoiding approval requires a GitHub App token or PAT, so the supported token-only workaround is `workflow_dispatch`.

**Tech Stack:** GitHub Actions reusable workflows, Python 3.14 stdlib, `pytest`, `ruff`, `mypy`, `prek`, `peter-evans/create-pull-request@v8`, `taiki-e/install-action@v2`, `gh` CLI on GitHub-hosted runners.

---

## File Structure

- Create `pyproject.toml`: package metadata and local tool settings.
- Create `src/prek_autoupdate/__init__.py`: package marker.
- Create `src/prek_autoupdate/cleanup_prek_update_branches.py`: canonical cleanup script, ported from the newest local `hass-animated-scenes` generation.
- Create `.github/workflows/prek_autoupdate.yml`: reusable workflow exposed via `workflow_call`.
- Create `.github/workflows/ci.yml`: local validation workflow for this repo.
- Create `tests/test_cleanup_prek_update_branches.py`: unit tests for cleanup ownership and branch deletion behavior.
- Create `tests/test_reusable_workflow.py`: text contract tests for the reusable workflow inputs and token-only dispatch behavior.
- Create `tests/test_readme.py`: documentation smoke tests for end-user examples and token caveats.
- Create `README.md`: end-user documentation and examples.
- Modify `MEMORY.md`: add a durable implementation breadcrumb after completion.

## Design Decisions

- Reusable workflow, not composite action: schedules, job permissions, concurrency, and cleanup jobs are workflow-level behavior.
- Keep `peter-evans/create-pull-request`: the workflow-trigger limitation is from `GITHUB_TOKEN`, not that action. Replacing it does not make normal PR CI auto-run without approval.
- Add optional `dispatch-workflows`: a newline-separated list of workflow filenames or IDs to run with `gh workflow run --ref <update-branch>`. This uses the documented `workflow_dispatch` exception for `GITHUB_TOKEN`.
- Require `actions: write` only when `dispatch-workflows` is used.
- Run cleanup every reusable workflow call. Run updates only when `force-update` is true or the UTC weekday matches `update-weekday`.

### Task 1: Project Scaffold

**Files:**
- Create: `pyproject.toml`
- Create: `src/prek_autoupdate/__init__.py`
- Create: `tests/__init__.py`

- [ ] **Step 1: Write the initial package metadata**

Create `pyproject.toml`:

```toml
[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[project]
name = "prek-autoupdate"
version = "0.1.0"
description = "Reusable GitHub workflow helpers for prek autoupdate pull requests."
readme = "README.md"
requires-python = ">=3.14"
license = "MIT"

[project.scripts]
prek-autoupdate-cleanup = "prek_autoupdate.cleanup_prek_update_branches:main"

[dependency-groups]
dev = [
  "mypy>=1.17.0",
  "pytest>=8.4.0",
  "ruff>=0.12.0",
]

[tool.hatch.build.targets.wheel]
packages = ["src/prek_autoupdate"]

[tool.pytest.ini_options]
testpaths = ["tests"]

[tool.ruff]
line-length = 100
target-version = "py314"

[tool.ruff.lint]
select = ["ALL"]
ignore = ["COM812", "D203", "D213"]

[tool.mypy]
python_version = "3.14"
strict = true
files = ["src", "tests"]
```

- [ ] **Step 2: Add package marker files**

Create `src/prek_autoupdate/__init__.py`:

```python
"""Reusable prek autoupdate workflow helpers."""
```

Create `tests/__init__.py`:

```python
"""Tests for prek-autoupdate."""
```

- [ ] **Step 3: Run the empty test suite**

Run:

```bash
python3 -m pytest
```

Expected: collection succeeds with no tests or reports no tests collected. If pytest is missing, run `uv sync --dev` first.

- [ ] **Step 4: Commit scaffold**

Run:

```bash
git add pyproject.toml src/prek_autoupdate/__init__.py tests/__init__.py
git commit -m "chore: scaffold prek autoupdate package"
```

### Task 2: Port the Canonical Cleanup Script

**Files:**
- Create: `src/prek_autoupdate/cleanup_prek_update_branches.py`
- Create: `tests/test_cleanup_prek_update_branches.py`

- [ ] **Step 1: Copy the newest cleanup script**

Copy the full contents of:

```text
/Users/snuffy2/GitHub/hass-animated-scenes/.github/scripts/cleanup_prek_update_branches.py
```

to:

```text
/Users/snuffy2/GitHub/prek-autoupdate/src/prek_autoupdate/cleanup_prek_update_branches.py
```

Keep these current-generation features from the source file:

```text
--keep-latest-open-pr
--delete-stale-branches
--delete-merged-branches
HTTPError, URLError, TimeoutError handling in main()
quote() for deleting branch refs containing slashes
```

- [ ] **Step 2: Write cleanup tests**

Create `tests/test_cleanup_prek_update_branches.py` with the ownership and branch cleanup tests from:

```text
/Users/snuffy2/GitHub/hass-animated-scenes/tests/test_prek_autoupdate_workflow.py
```

Keep these tests and change the import to `from prek_autoupdate import cleanup_prek_update_branches as cleanup`:

```python
def test_cleanup_script_closes_stale_prs_and_deletes_workflow_branches() -> None: ...
def test_cleanup_script_keeps_active_update_branch() -> None: ...
def test_cleanup_script_can_keep_latest_open_workflow_pr() -> None: ...
def test_cleanup_script_deletes_orphaned_update_branches() -> None: ...
def test_cleanup_script_preserves_human_prs_with_matching_label_and_prefix() -> None: ...
def test_cleanup_script_preserves_bot_prs_without_workflow_body_marker() -> None: ...
def test_github_headers_include_json_content_type() -> None: ...
def test_main_returns_failure_for_github_request_errors() -> None: ...
```

Use this fake client shape:

```python
class FakeCleanupClient:
    """Fake GitHub cleanup client that records mutating calls."""

    def __init__(
        self,
        *,
        open_pulls: list[dict[str, object]],
        closed_pulls: list[dict[str, object]],
        branches: list[str] | None = None,
        fail_on_close: bool = False,
    ) -> None:
        self.open_pulls = open_pulls
        self.closed_pulls = closed_pulls
        self.branches = branches or []
        self.fail_on_close = fail_on_close
        self.closed_prs: list[int] = []
        self.deleted_refs: list[str] = []
        self.max_pages_by_state: dict[str, int | None] = {}

    def list_pulls(self, *, state: str, max_pages: int | None = None) -> list[dict[str, object]]:
        self.max_pages_by_state[state] = max_pages
        return self.open_pulls if state == "open" else self.closed_pulls

    def list_branches(self) -> list[str]:
        return self.branches

    def close_pull(self, pull_number: int) -> None:
        if self.fail_on_close:
            raise AssertionError(f"Unexpected close for PR {pull_number}")
        self.closed_prs.append(pull_number)

    def delete_ref(self, ref: str) -> None:
        self.deleted_refs.append(ref)
```

- [ ] **Step 3: Run cleanup tests**

Run:

```bash
python3 -m pytest tests/test_cleanup_prek_update_branches.py -q
```

Expected: all cleanup tests pass.

- [ ] **Step 4: Run lint and type checks for the cleanup module**

Run:

```bash
python3 -m ruff check src/prek_autoupdate/cleanup_prek_update_branches.py tests/test_cleanup_prek_update_branches.py
python3 -m mypy src/prek_autoupdate/cleanup_prek_update_branches.py tests/test_cleanup_prek_update_branches.py
```

Expected: both commands pass.

- [ ] **Step 5: Commit cleanup script**

Run:

```bash
git add src/prek_autoupdate/cleanup_prek_update_branches.py tests/test_cleanup_prek_update_branches.py
git commit -m "feat: add prek update cleanup helper"
```

### Task 3: Add the Reusable Workflow

**Files:**
- Create: `.github/workflows/prek_autoupdate.yml`
- Create: `tests/test_reusable_workflow.py`

- [ ] **Step 1: Write workflow contract tests first**

Create `tests/test_reusable_workflow.py`:

```python
"""Contract tests for the reusable prek autoupdate workflow."""

from pathlib import Path

WORKFLOW = Path(".github/workflows/prek_autoupdate.yml")


def test_workflow_is_reusable() -> None:
    """Workflow should be called by other repositories."""
    text = WORKFLOW.read_text(encoding="utf-8")

    assert "workflow_call:" in text
    assert "force-update:" in text
    assert "update-weekday:" in text
    assert "dispatch-workflows:" in text


def test_workflow_checks_out_target_and_tooling_repositories() -> None:
    """Workflow should separate caller code from this tooling repo."""
    text = WORKFLOW.read_text(encoding="utf-8")

    assert "path: target" in text
    assert "path: tooling" in text
    assert "repository: ${{ inputs.tool-repository }}" in text
    assert "ref: ${{ inputs.tool-ref }}" in text


def test_workflow_uses_github_token_dispatch_exception() -> None:
    """Workflow should optionally dispatch named workflows on the update branch."""
    text = WORKFLOW.read_text(encoding="utf-8")

    assert "GH_TOKEN: ${{ github.token }}" in text
    assert "gh workflow run" in text
    assert "--ref \"${UPDATE_BRANCH}\"" in text
    assert "actions: write" in text


def test_workflow_runs_cleanup_even_when_update_is_skipped() -> None:
    """Workflow should keep stale PR cleanup independent from weekly update creation."""
    text = WORKFLOW.read_text(encoding="utf-8")

    assert "cleanup:" in text
    assert "if: always()" in text
    assert "--keep-latest-open-pr" in text
    assert "--delete-stale-branches" in text
    assert "--delete-merged-branches" in text
```

- [ ] **Step 2: Run workflow tests and confirm failure**

Run:

```bash
python3 -m pytest tests/test_reusable_workflow.py -q
```

Expected: fail because `.github/workflows/prek_autoupdate.yml` does not exist.

- [ ] **Step 3: Create the reusable workflow**

Create `.github/workflows/prek_autoupdate.yml`:

```yaml
name: Reusable prek Autoupdate

on:
  workflow_call:
    inputs:
      force-update:
        description: Run prek update regardless of update-weekday.
        required: false
        type: boolean
        default: false
      update-weekday:
        description: UTC weekday number for scheduled updates, 1 is Monday.
        required: false
        type: string
        default: "1"
      cooldown-days:
        description: Cooldown days passed to prek auto-update.
        required: false
        type: string
        default: "7"
      update-branch:
        description: Branch used for the generated update PR.
        required: false
        type: string
        default: chore/prek-updates
      branch-prefix:
        description: Branch prefix considered owned by this workflow.
        required: false
        type: string
        default: chore/prek-updates
      label:
        description: Label applied to generated PRs and used for cleanup ownership checks.
        required: false
        type: string
        default: dependencies
      commit-message:
        description: Commit message for hook update commits.
        required: false
        type: string
        default: "chore: update prek hooks"
      pr-title:
        description: Title for hook update PRs.
        required: false
        type: string
        default: Bump prek Hooks
      add-paths:
        description: Newline-separated paths peter-evans/create-pull-request may commit.
        required: false
        type: string
        default: prek.toml
      dispatch-workflows:
        description: Newline-separated workflow filenames or IDs to workflow_dispatch on the update branch.
        required: false
        type: string
        default: ""
      tool-repository:
        description: Repository containing the cleanup helper.
        required: false
        type: string
        default: Snuffy2/prek-autoupdate
      tool-ref:
        description: Ref of tool-repository to checkout.
        required: false
        type: string
        default: main
      python-version:
        description: Python version used for cleanup.
        required: false
        type: string
        default: "3.14"

concurrency:
  group: prek-autoupdate-${{ github.repository }}
  cancel-in-progress: false

jobs:
  update-hooks:
    name: Update prek Hooks
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      actions: write
    outputs:
      pull-request-number: ${{ steps.cpr.outputs.pull-request-number }}
      should-update: ${{ steps.update-window.outputs.should-update }}
    steps:
      - name: Check update window
        id: update-window
        env:
          FORCE_UPDATE: ${{ inputs.force-update }}
          UPDATE_WEEKDAY: ${{ inputs.update-weekday }}
        run: |
          set -euo pipefail

          if [[ "${FORCE_UPDATE}" == "true" ]] || [[ "$(date -u +%u)" == "${UPDATE_WEEKDAY}" ]]; then
            echo "should-update=true" >> "${GITHUB_OUTPUT}"
          else
            echo "should-update=false" >> "${GITHUB_OUTPUT}"
          fi

      - name: Checkout Target Repository
        if: steps.update-window.outputs.should-update == 'true'
        uses: actions/checkout@v7
        with:
          path: target
          persist-credentials: false

      - name: Set up Python
        if: steps.update-window.outputs.should-update == 'true'
        uses: actions/setup-python@v6
        with:
          python-version: ${{ inputs.python-version }}
          cache: pip

      - name: Install prek
        if: steps.update-window.outputs.should-update == 'true'
        uses: taiki-e/install-action@v2
        with:
          tool: prek

      - name: Run prek auto-update
        if: steps.update-window.outputs.should-update == 'true'
        working-directory: target
        run: |
          set -euo pipefail
          body_file="${GITHUB_WORKSPACE}/prek-autoupdate-body.md"
          {
            echo "Automated update of \`prek\` hooks."
            echo
            echo '```text'
            prek auto-update --cooldown-days "${{ inputs.cooldown-days }}" 2>&1
            echo '```'
          } | tee "${body_file}"

      - name: Create Pull Request
        if: steps.update-window.outputs.should-update == 'true'
        id: cpr
        uses: peter-evans/create-pull-request@v8
        with:
          path: target
          token: ${{ github.token }}
          commit-message: ${{ inputs.commit-message }}
          title: ${{ inputs.pr-title }}
          branch: ${{ inputs.update-branch }}
          author: github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>
          labels: ${{ inputs.label }}
          delete-branch: true
          body-path: prek-autoupdate-body.md
          add-paths: ${{ inputs.add-paths }}

      - name: Dispatch workflows for update branch
        if: steps.cpr.outputs.pull-request-number != '' && inputs.dispatch-workflows != ''
        env:
          DISPATCH_WORKFLOWS: ${{ inputs.dispatch-workflows }}
          GH_TOKEN: ${{ github.token }}
          UPDATE_BRANCH: ${{ inputs.update-branch }}
        run: |
          set -euo pipefail

          while IFS= read -r workflow; do
            [[ -z "${workflow}" ]] && continue
            gh workflow run "${workflow}" --ref "${UPDATE_BRANCH}"
          done <<< "${DISPATCH_WORKFLOWS}"

  cleanup:
    name: Cleanup prek Update PRs
    runs-on: ubuntu-latest
    needs: update-hooks
    if: always()
    permissions:
      contents: write
      pull-requests: write
    steps:
      - name: Checkout Tooling Repository
        uses: actions/checkout@v7
        with:
          repository: ${{ inputs.tool-repository }}
          ref: ${{ inputs.tool-ref }}
          path: tooling
          persist-credentials: false

      - name: Set up Python
        uses: actions/setup-python@v6
        with:
          python-version: ${{ inputs.python-version }}

      - name: Close stale prek update PRs
        env:
          BODY_MARKER: Automated update of `prek` hooks.
          GITHUB_TOKEN: ${{ github.token }}
          KEEP_PR_NUMBER: ${{ needs.update-hooks.outputs.pull-request-number }}
          REPOSITORY: ${{ github.repository }}
        run: |
          set -euo pipefail

          args=(
            --repository "${REPOSITORY}"
            --branch "${{ inputs.update-branch }}"
            --branch-prefix "${{ inputs.branch-prefix }}"
            --label-name "${{ inputs.label }}"
            --author-login 'github-actions[bot]'
            --body-marker "${BODY_MARKER}"
            --close-stale-prs
            --delete-stale-branches
            --delete-merged-branches
          )

          if [[ -n "${KEEP_PR_NUMBER}" ]]; then
            args+=(--keep-pr-number "${KEEP_PR_NUMBER}")
          else
            args+=(--keep-latest-open-pr)
          fi

          python tooling/src/prek_autoupdate/cleanup_prek_update_branches.py "${args[@]}"
```

- [ ] **Step 4: Run workflow tests**

Run:

```bash
python3 -m pytest tests/test_reusable_workflow.py -q
```

Expected: all workflow contract tests pass.

- [ ] **Step 5: Commit reusable workflow**

Run:

```bash
git add .github/workflows/prek_autoupdate.yml tests/test_reusable_workflow.py
git commit -m "feat: add reusable prek autoupdate workflow"
```

### Task 4: Add README End-User Documentation

**Files:**
- Create: `README.md`
- Create: `tests/test_readme.py`

- [ ] **Step 1: Write README tests first**

Create `tests/test_readme.py`:

```python
"""Documentation smoke tests."""

from pathlib import Path

README = Path("README.md")


def test_readme_documents_reusable_workflow_usage() -> None:
    """README should show a minimal caller workflow."""
    text = README.read_text(encoding="utf-8")

    assert "jobs:" in text
    assert "uses: Snuffy2/prek-autoupdate/.github/workflows/prek_autoupdate.yml@v1" in text
    assert "force-update: ${{ github.event_name == 'workflow_dispatch' }}" in text
    assert "permissions:" in text
    assert "contents: write" in text
    assert "pull-requests: write" in text


def test_readme_documents_dispatch_workflows_token_caveat() -> None:
    """README should explain the GITHUB_TOKEN workflow trigger boundary."""
    text = README.read_text(encoding="utf-8")

    assert "dispatch-workflows" in text
    assert "workflow_dispatch" in text
    assert "actions: write" in text
    assert "GitHub App token or PAT" in text
    assert "GITHUB_TOKEN" in text
```

- [ ] **Step 2: Run README tests and confirm failure**

Run:

```bash
python3 -m pytest tests/test_readme.py -q
```

Expected: fail because `README.md` does not exist.

- [ ] **Step 3: Create README**

Create `README.md` with these sections:

```markdown
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

permissions:
  contents: write
  pull-requests: write

jobs:
  prek-autoupdate:
    uses: Snuffy2/prek-autoupdate/.github/workflows/prek_autoupdate.yml@v1
    permissions:
      contents: write
      pull-requests: write
    with:
      force-update: ${{ github.event_name == 'workflow_dispatch' }}
      update-weekday: "1"
```

This runs cleanup daily and runs `prek auto-update` on Mondays or when manually dispatched.

## Run CI on the Update Branch

GitHub limits what events can be triggered by the repository `GITHUB_TOKEN`. PRs created by automation may require manual workflow approval, and fully automatic PR workflow runs without that approval require a GitHub App token or PAT.

This project does not require per-repository custom tokens. If you want token-only runs, add `workflow_dispatch` to the workflows you want to run, grant `actions: write`, and list them in `dispatch-workflows`:

```yaml
permissions:
  contents: write
  pull-requests: write
  actions: write

jobs:
  prek-autoupdate:
    uses: Snuffy2/prek-autoupdate/.github/workflows/prek_autoupdate.yml@v1
    permissions:
      contents: write
      pull-requests: write
      actions: write
    with:
      force-update: ${{ github.event_name == 'workflow_dispatch' }}
      update-weekday: "1"
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

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `force-update` | `false` | Run update regardless of weekday. Pass `${{ github.event_name == 'workflow_dispatch' }}` from caller workflows. |
| `update-weekday` | `"1"` | UTC weekday for scheduled updates. `1` is Monday. |
| `cooldown-days` | `"7"` | Value passed to `prek auto-update --cooldown-days`. |
| `update-branch` | `chore/prek-updates` | Branch used for update PRs. |
| `branch-prefix` | `chore/prek-updates` | Prefix considered owned by cleanup. |
| `label` | `dependencies` | PR label used for generated PRs and cleanup ownership checks. |
| `commit-message` | `chore: update prek hooks` | Commit message for update commits. |
| `pr-title` | `Bump prek Hooks` | Pull request title. |
| `add-paths` | `prek.toml` | Newline-separated paths the PR action may commit. |
| `dispatch-workflows` | empty | Newline-separated workflow names, filenames, or IDs to run on the update branch with `workflow_dispatch`. |
| `tool-repository` | `Snuffy2/prek-autoupdate` | Repository containing cleanup tooling. |
| `tool-ref` | `main` | Ref used when checking out cleanup tooling. Pin this to `v1` in stable consumers. |
| `python-version` | `"3.14"` | Python runtime for cleanup. |

## Recommended Stable Caller

After the first release tag exists, pin both the reusable workflow and tooling checkout:

```yaml
jobs:
  prek-autoupdate:
    uses: Snuffy2/prek-autoupdate/.github/workflows/prek_autoupdate.yml@v1
    permissions:
      contents: write
      pull-requests: write
    with:
      force-update: ${{ github.event_name == 'workflow_dispatch' }}
      tool-ref: v1
```
```

- [ ] **Step 4: Run README tests**

Run:

```bash
python3 -m pytest tests/test_readme.py -q
```

Expected: all README tests pass.

- [ ] **Step 5: Commit README**

Run:

```bash
git add README.md tests/test_readme.py
git commit -m "docs: document reusable prek autoupdate workflow"
```

### Task 5: Add CI for This Repo

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create local validation workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  pull_request:
  push:
    branches:
      - main
  workflow_dispatch:

permissions:
  contents: read

jobs:
  test:
    name: Test
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Repository
        uses: actions/checkout@v7

      - name: Set up Python
        uses: actions/setup-python@v6
        with:
          python-version: "3.14"
          cache: pip

      - name: Install dependencies
        run: python -m pip install -e ".[dev]"

      - name: Ruff
        run: ruff check .

      - name: Mypy
        run: mypy

      - name: Pytest
        run: pytest
```

- [ ] **Step 2: Run full local validation**

Run:

```bash
python3 -m ruff check .
python3 -m mypy
python3 -m pytest -q
```

Expected: all commands pass.

- [ ] **Step 3: Commit CI**

Run:

```bash
git add .github/workflows/ci.yml
git commit -m "ci: validate reusable prek autoupdate workflow"
```

### Task 6: Final Integration Check

**Files:**
- Modify: `MEMORY.md`

- [ ] **Step 1: Review the final diff**

Run:

```bash
git status --short --branch
git diff --stat HEAD
git diff HEAD -- .github/workflows/prek_autoupdate.yml README.md src/prek_autoupdate/cleanup_prek_update_branches.py
```

Expected: only the planned files are changed since the last commit. If the previous tasks committed each step, this diff should be empty.

- [ ] **Step 2: Add memory breadcrumb**

Append to `MEMORY.md`:

```markdown
## 2026-07-05 reusable workflow implementation

This repo now owns the reusable `prek_autoupdate.yml` workflow, the canonical cleanup script, tests, and README examples. The workflow uses `GITHUB_TOKEN`; normal PR workflow auto-approval still requires a GitHub App token or PAT, but `dispatch-workflows` can run named `workflow_dispatch` workflows on the update branch with `actions: write`.
```

- [ ] **Step 3: Run final validation after memory update**

Run:

```bash
python3 -m ruff check .
python3 -m mypy
python3 -m pytest -q
```

Expected: all commands pass.

- [ ] **Step 4: Report next publish step**

Do not push unless the user explicitly authorizes it. Report:

```text
Implementation complete locally. To make consumers use @v1, tag and push v1 after review.
```

## Self-Review

- Spec coverage: reusable workflow, README examples, cleanup script consolidation, tests, and token-only workflow dispatch are each covered by a task.
- Placeholder scan: no unresolved placeholder sections remain.
- Type consistency: workflow input names match README examples and workflow tests.
- YAGNI check: no custom PR creator is planned because it cannot bypass the documented `GITHUB_TOKEN` trigger boundary.

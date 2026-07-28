# AGENTS.md

This repository maintains the reusable `prek` autoupdate workflow and its cleanup helper. Keep changes small, tested, and safe for downstream repositories that grant this workflow write permissions.

## Repository Shape

- `.github/workflows/prek_autoupdate.yml` is the reusable workflow consumed by other repositories.
- `src/prek_autoupdate/cleanup_prek_update_branches.py` is the canonical cleanup helper run by the workflow.
- `README.md` is the end-user contract. Update it with any input, permission, token, or caller-example change.
- `tests/` contains cleanup behavior tests.

## Source Of Truth Rules

- Keep consuming-repo YAML examples thin: schedule plus `jobs.<job>.uses`.
- Keep the caller example's `push` trigger for `main` aligned with the reusable workflow's cleanup-only reconciliation path. Pushes must not run `prek auto-update`, create a PR, or update a still-needed PR; cleanup may close only a workflow-owned PR whose current detail reports zero changed files.
- Do not copy the cleanup script back into downstream repos. Fix it here and update callers to use this repo.
- Treat `.github/workflows/prek_autoupdate.yml` and `README.md` as a public API. Renaming inputs or changing defaults requires docs in the same change.
- Do not request `actions: write`; no active workflow path needs it.

## GitHub Token And Deprecated Dispatch Input

- This project must work with the repository `GITHUB_TOKEN`; do not require per-repo PATs or custom app tokens for the normal path.
- A PAT is not an option for this project. Do not add, recommend, or document a classic or fine-grained PAT as a solution, optional escape hatch, fallback, advanced configuration, or secret input for this repository or its downstream callers.
- PR workflow approval limits are a GitHub platform behavior.
- Keep `dispatch-workflows` as an accepted but ignored compatibility input so existing callers do not fail workflow validation. Do not restore workflow dispatch or approval-run deletion behavior without an explicit redesign.

## Cleanup Safety

- Branch and PR cleanup must prove workflow ownership before mutating anything. Keep the label, author, body marker, same-repo head, and branch-prefix checks intact unless replacing them with stricter checks.
- Do not cap merged PR cleanup to an arbitrary page count. The helper should follow pagination until GitHub has no next page.
- Deletion should remain idempotent for missing refs.
- Prefer stdlib for the cleanup helper. Do not add a GitHub client dependency unless it removes more code than it adds.

## Python And Tooling

- Use Python 3.14.
- Use `uv run` for local validation.
- `uv.lock` is intentionally ignored and should not be committed.
- Keep `ruff`, `mypy`, and `pytest` green before saying the branch is ready.

Run the full local gate:

```sh
uv run ruff check .
uv run mypy
uv run pytest -q
```

## Tests

- Cleanup tests should cover ownership boundaries before branch deletion.
- For cleanup helper bug fixes, add a regression test that fails before the fix.

# AGENTS.md

This repository maintains the reusable `prek` autoupdate workflow and its cleanup helper. Keep changes small, tested, and safe for downstream repositories that grant this workflow write permissions.

## Repository Shape

- `.github/workflows/prek_autoupdate.yml` is the reusable workflow consumed by other repositories.
- `src/prek_autoupdate/cleanup_prek_update_branches.py` is the canonical cleanup helper run by the workflow.
- `README.md` is the end-user contract. Update it with any input, permission, token, or caller-example change.
- `tests/` contains contract tests for the workflow, README, and cleanup behavior.

## Source Of Truth Rules

- Keep consuming-repo YAML examples thin: schedule plus `jobs.<job>.uses`.
- Do not copy the cleanup script back into downstream repos. Fix it here and update callers to use this repo.
- Treat `.github/workflows/prek_autoupdate.yml` and `README.md` as a public API. Renaming inputs or changing defaults requires docs and tests in the same change.
- `tool-ref` must stay pinned by default to the same release line as the reusable workflow, currently `v1`. Do not default it to `main`; that decouples pinned callers from the cleanup code they execute.
- Do not broaden token permissions casually. `actions: write` is only for the optional `dispatch-workflows` path; cleanup should not receive it.

## GitHub Token And Workflow Dispatch

- This project must work with the repository `GITHUB_TOKEN`; do not require per-repo PATs or custom app tokens for the normal path.
- PR workflow approval limits are a GitHub platform behavior. The token-only workaround here is `dispatch-workflows`, which calls `workflow_dispatch` on named workflows.
- Document that dispatched workflows must already exist on the consuming repository default branch.

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

- Workflow tests should assert behavioral contracts, not only file existence.
- README tests should guard caller examples and token caveats.
- Cleanup tests should cover ownership boundaries before branch deletion.
- For bug fixes, add a regression test that fails before the fix.

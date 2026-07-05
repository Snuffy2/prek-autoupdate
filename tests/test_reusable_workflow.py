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

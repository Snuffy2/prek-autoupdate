"""Contract tests for the reusable prek autoupdate workflow."""

from pathlib import Path

WORKFLOW = Path(".github/workflows/prek_autoupdate.yml")


def _job_section(text: str, job_name: str) -> str:
    """Return the text for a workflow job."""
    marker = f"  {job_name}:\n"
    start = text.index(marker)
    if job_name == "update-hooks":
        return text[start : text.index("\n  cleanup:\n")]
    return text[start:]


def test_workflow_is_reusable() -> None:
    """Workflow should be called by other repositories."""
    text = WORKFLOW.read_text(encoding="utf-8")

    assert "workflow_call:" in text
    assert "force-update:" not in text
    assert "update-weekday:" not in text
    assert "update-window" not in text
    assert "should-update" not in text
    assert "dispatch-workflows:" in text
    assert "default: v1" in text


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
    update_job = _job_section(text, "update-hooks")
    cleanup_job = _job_section(text, "cleanup")

    assert "GH_TOKEN: ${{ github.token }}" in text
    assert "gh workflow run" in text
    assert '--ref "${UPDATE_BRANCH}"' in text
    assert "actions: write" in update_job
    assert "actions: write" not in cleanup_job
    assert "contents: write" in update_job
    assert "pull-requests: write" in update_job


def test_workflow_runs_cleanup_after_update_job() -> None:
    """Workflow should run cleanup after the update job finishes."""
    text = WORKFLOW.read_text(encoding="utf-8")

    assert "cleanup:" in text
    assert "if: always()" in text
    assert "--keep-latest-open-pr" in text
    assert "--delete-stale-branches" in text
    assert "--delete-merged-branches" in text
    assert "BODY_MARKER: Automated update of `prek` hooks." in text
    assert 'echo "Automated update of \\`prek\\` hooks."' in text

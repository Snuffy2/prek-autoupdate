"""Tests for the reusable workflow's compatibility contract."""

from __future__ import annotations

from pathlib import Path

WORKFLOW = (Path(__file__).parents[1] / ".github" / "workflows" / "prek_autoupdate.yml").read_text()


def test_push_only_reconciles_obsolete_pull_requests() -> None:
    """Pushes should reconcile the PR without running prek auto-update."""
    assert (
        'if [[ "${{ github.event_name }}" == "workflow_dispatch" || '
        '( "${{ github.event_name }}" == "schedule"' in WORKFLOW
    )
    assert "steps.update-day.outputs.should-update == 'true' || github.event_name" not in WORKFLOW
    assert 'if [[ "${EVENT_NAME}" == "push" ]]; then' in WORKFLOW
    assert "args+=(--close-obsolete-prs)" in WORKFLOW


def test_deprecated_dispatch_workflows_input_is_accepted_but_ignored() -> None:
    """The retired input remains valid for callers but has no behavior."""
    assert "      dispatch-workflows:\n" in WORKFLOW
    assert "Deprecated compatibility input. Accepted but ignored." in WORKFLOW
    assert "inputs.dispatch-workflows" not in WORKFLOW
    assert "actions: write" not in WORKFLOW
    assert "  dispatch-workflows:" not in WORKFLOW.splitlines()

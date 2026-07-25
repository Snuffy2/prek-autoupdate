"""Tests for the reusable workflow's compatibility contract."""

from __future__ import annotations

from pathlib import Path

WORKFLOW = (Path(__file__).parents[1] / ".github" / "workflows" / "prek_autoupdate.yml").read_text()


def test_deprecated_dispatch_workflows_input_is_accepted_but_ignored() -> None:
    """The retired input remains valid for callers but has no behavior."""
    assert "      dispatch-workflows:\n" in WORKFLOW
    assert "Deprecated compatibility input. Accepted but ignored." in WORKFLOW
    assert "inputs.dispatch-workflows" not in WORKFLOW
    assert "actions: write" not in WORKFLOW
    assert "  dispatch-workflows:" not in WORKFLOW.splitlines()

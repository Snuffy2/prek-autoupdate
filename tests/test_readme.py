"""Documentation smoke tests."""

from pathlib import Path

README = Path("README.md")


def test_readme_documents_reusable_workflow_usage() -> None:
    """README should show a minimal caller workflow."""
    text = README.read_text(encoding="utf-8")

    assert "## Quick Start" in text
    assert "uses: Snuffy2/prek-autoupdate/.github/workflows/prek_autoupdate.yml@v1" in text
    assert "force-update: ${{ github.event_name == 'workflow_dispatch' }}" in text
    assert "permissions:" in text
    assert "contents: write" in text
    assert "pull-requests: write" in text
    assert "## Recommended Stable Caller" not in text
    assert "tool-ref: v1" not in text
    assert "Usually omit this so the workflow default is used." in text


def test_readme_documents_dispatch_workflows_token_caveat() -> None:
    """README should explain the GITHUB_TOKEN workflow trigger boundary."""
    text = README.read_text(encoding="utf-8")

    assert "dispatch-workflows" in text
    assert "workflow_dispatch" in text
    assert "actions: write" in text
    assert "GitHub App token or PAT" in text
    assert "GITHUB_TOKEN" in text
    assert "default branch" in text

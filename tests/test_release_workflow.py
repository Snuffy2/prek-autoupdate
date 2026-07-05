"""Contract tests for the release workflow."""

from pathlib import Path

WORKFLOW = Path(".github/workflows/release.yml")


def test_release_workflow_updates_pyproject_and_moves_tag() -> None:
    """Release workflow should commit the release version and move the tag."""
    text = WORKFLOW.read_text(encoding="utf-8")

    assert "release:" in text
    assert "types: [published, edited]" in text
    assert 'version="${TAG_NAME#v}"' in text
    assert 'sed -i "s/^version = \\".*\\"/version = \\"${version}\\"/" pyproject.toml' in text
    assert "stefanzweifel/git-auto-commit-action@v7" in text
    assert 'commit_message: "Updating to version $' in text
    assert 'git tag -f "${{ github.event.release.tag_name }}"' in text
    assert 'git push -f origin "${{ github.event.release.tag_name }}"' in text
    assert 'major_tag="${TAG_NAME%%.*}"' in text
    assert 'git push -f origin "${major_tag}"' in text

"""Tests for prek autoupdate branch cleanup."""

from __future__ import annotations

from email.message import Message
from io import BytesIO
from urllib.error import HTTPError, URLError

import pytest

from prek_autoupdate import cleanup_prek_update_branches as cleanup

WORKFLOW_BRANCH = "chore/prek-updates"
WORKFLOW_LABEL = "dependencies"
WORKFLOW_AUTHOR = "github-actions[bot]"
WORKFLOW_BODY_MARKER = "Automated update of `prek` hooks."
REPOSITORY = "o/r"


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
        """Initialize fake pull request state.

        Args:
            open_pulls: Pull requests to return for open PR lookups.
            closed_pulls: Pull requests to return for closed PR lookups.
            branches: Branch refs to return for matching branch lookups.
            fail_on_close: Whether closing a PR should fail the test.

        """
        self.open_pulls = open_pulls
        self.closed_pulls = closed_pulls
        self.branches = [] if branches is None else branches
        self.fail_on_close = fail_on_close
        self.closed_prs: list[int] = []
        self.deleted_refs: list[str] = []

    def list_pulls(self, *, state: str) -> list[dict[str, object]]:
        """Return fake pull requests by state."""
        if state == "open":
            return self.open_pulls
        if state == "closed":
            return self.closed_pulls
        raise ValueError(f"Unsupported pull request state: {state}")

    def list_branches(self, *, ref_prefix: str) -> list[str]:
        """Return fake git refs by prefix."""
        return [ref for ref in self.branches if ref.startswith(f"refs/{ref_prefix}")]

    def close_pull(self, pull_number: int) -> None:
        """Record or reject a closed pull request."""
        if self.fail_on_close:
            raise AssertionError(f"Unexpected close for PR {pull_number}")
        self.closed_prs.append(pull_number)

    def delete_ref(self, ref: str) -> None:
        """Record a deleted git ref."""
        self.deleted_refs.append(ref)


def _workflow_pull(
    *,
    number: int,
    ref: str = WORKFLOW_BRANCH,
    label: str = WORKFLOW_LABEL,
    author: str = WORKFLOW_AUTHOR,
    body: str = WORKFLOW_BODY_MARKER,
    repository: str = REPOSITORY,
    merged_at: str | None = None,
) -> dict[str, object]:
    """Return a fake workflow pull request object."""
    return {
        "number": number,
        "merged_at": merged_at,
        "body": body,
        "user": {"login": author},
        "head": {"ref": ref, "repo": {"full_name": repository}},
        "labels": [{"name": label}],
    }


def _cleanup(
    client: FakeCleanupClient,
    *,
    keep_pr_number: int | None = None,
    keep_latest_open_pr: bool = False,
    delete_stale_branches: bool = False,
    delete_merged_branches: bool = True,
) -> cleanup.CleanupResult:
    """Run cleanup with workflow defaults."""
    return cleanup.cleanup_update_branches(
        client=client,
        repository=REPOSITORY,
        branch=WORKFLOW_BRANCH,
        branch_prefix=WORKFLOW_BRANCH,
        label_name=WORKFLOW_LABEL,
        author_login=WORKFLOW_AUTHOR,
        body_marker=WORKFLOW_BODY_MARKER,
        keep_pr_number=keep_pr_number,
        keep_latest_open_pr=keep_latest_open_pr,
        close_stale_prs=True,
        delete_stale_branches=delete_stale_branches,
        delete_merged_branches=delete_merged_branches,
    )


def test_cleanup_script_closes_stale_prs_and_deletes_workflow_branches() -> None:
    """Cleanup script should close stale PRs and remove workflow-created branches."""
    client = FakeCleanupClient(
        open_pulls=[
            _workflow_pull(number=10),
            _workflow_pull(number=9, ref=f"{WORKFLOW_BRANCH}-old"),
            _workflow_pull(number=11, ref="feature/manual"),
        ],
        closed_pulls=[
            _workflow_pull(number=8, merged_at="2026-05-28T00:00:00Z"),
            _workflow_pull(number=7, ref=f"{WORKFLOW_BRANCH}-old"),
        ],
    )

    result = _cleanup(client)

    assert client.closed_prs == [10, 9]
    assert client.deleted_refs == [
        f"heads/{WORKFLOW_BRANCH}",
        f"heads/{WORKFLOW_BRANCH}-old",
    ]
    assert result.closed_prs == [10, 9]
    assert result.deleted_branches == [WORKFLOW_BRANCH, f"{WORKFLOW_BRANCH}-old"]


def test_cleanup_script_keeps_active_update_branch() -> None:
    """Cleanup script should not delete the branch for the kept update PR."""
    client = FakeCleanupClient(
        open_pulls=[_workflow_pull(number=12)],
        closed_pulls=[
            _workflow_pull(number=8, merged_at="2026-05-28T00:00:00Z"),
            _workflow_pull(
                number=6,
                ref=f"{WORKFLOW_BRANCH}-old",
                merged_at="2026-05-20T00:00:00Z",
            ),
        ],
        fail_on_close=True,
    )

    result = _cleanup(client, keep_pr_number=12)

    assert client.deleted_refs == [f"heads/{WORKFLOW_BRANCH}-old"]
    assert result.closed_prs == []
    assert result.deleted_branches == [f"{WORKFLOW_BRANCH}-old"]


def test_cleanup_script_can_keep_latest_open_workflow_pr() -> None:
    """Cleanup script should preserve the newest open PR during nightly cleanup."""
    client = FakeCleanupClient(
        open_pulls=[
            _workflow_pull(number=17, ref=f"{WORKFLOW_BRANCH}-old"),
            _workflow_pull(number=18),
        ],
        closed_pulls=[
            _workflow_pull(
                number=16, ref=f"{WORKFLOW_BRANCH}-merged", merged_at="2026-05-28T00:00:00Z"
            ),
        ],
    )

    result = _cleanup(client, keep_latest_open_pr=True)

    assert client.closed_prs == [17]
    assert client.deleted_refs == [
        f"heads/{WORKFLOW_BRANCH}-merged",
        f"heads/{WORKFLOW_BRANCH}-old",
    ]
    assert result.closed_prs == [17]
    assert result.deleted_branches == [f"{WORKFLOW_BRANCH}-merged", f"{WORKFLOW_BRANCH}-old"]


def test_cleanup_script_checks_all_closed_pulls_for_merged_workflow_branches() -> None:
    """Cleanup script should not cap merged workflow branch cleanup to recent PR pages."""
    client = FakeCleanupClient(
        open_pulls=[],
        closed_pulls=[
            _workflow_pull(
                number=4,
                ref=f"{WORKFLOW_BRANCH}-old-merged",
                merged_at="2026-05-01T00:00:00Z",
            ),
        ],
    )

    result = _cleanup(client)

    assert client.deleted_refs == [f"heads/{WORKFLOW_BRANCH}-old-merged"]
    assert result.deleted_branches == [f"{WORKFLOW_BRANCH}-old-merged"]


def test_cleanup_script_deletes_orphaned_update_branches() -> None:
    """Cleanup script should delete prefixed workflow branches without open PRs."""
    client = FakeCleanupClient(
        open_pulls=[_workflow_pull(number=18)],
        closed_pulls=[],
        branches=[
            f"refs/heads/{WORKFLOW_BRANCH}",
            f"refs/heads/{WORKFLOW_BRANCH}-orphan",
            f"refs/heads/{WORKFLOW_BRANCH}-manual",
        ],
    )

    result = _cleanup(
        client,
        keep_latest_open_pr=True,
        delete_stale_branches=True,
        delete_merged_branches=False,
    )

    assert client.deleted_refs == [
        f"heads/{WORKFLOW_BRANCH}-manual",
        f"heads/{WORKFLOW_BRANCH}-orphan",
    ]
    assert result.deleted_branches == [f"{WORKFLOW_BRANCH}-manual", f"{WORKFLOW_BRANCH}-orphan"]


def test_cleanup_script_preserves_open_non_workflow_pr_branches() -> None:
    """Cleanup script should not delete branches used by open non-workflow PRs."""
    client = FakeCleanupClient(
        open_pulls=[
            _workflow_pull(number=18),
            _workflow_pull(
                number=19,
                ref=f"{WORKFLOW_BRANCH}-manual-fix",
                author="maintainer",
                body="Manual maintenance PR.",
            ),
            _workflow_pull(
                number=20,
                ref=f"{WORKFLOW_BRANCH}-external",
                author="maintainer",
                body="External fork PR.",
                repository="fork/r",
            ),
        ],
        closed_pulls=[],
        branches=[
            f"refs/heads/{WORKFLOW_BRANCH}",
            f"refs/heads/{WORKFLOW_BRANCH}-manual-fix",
            f"refs/heads/{WORKFLOW_BRANCH}-orphan",
        ],
    )

    result = _cleanup(
        client,
        keep_latest_open_pr=True,
        delete_stale_branches=True,
        delete_merged_branches=False,
    )

    assert client.deleted_refs == [f"heads/{WORKFLOW_BRANCH}-orphan"]
    assert result.deleted_branches == [f"{WORKFLOW_BRANCH}-orphan"]


def test_cleanup_script_preserves_human_prs_with_matching_label_and_prefix() -> None:
    """Cleanup script should not mutate human PRs that share labels and prefixes."""
    client = FakeCleanupClient(
        open_pulls=[
            _workflow_pull(number=13, ref=f"{WORKFLOW_BRANCH}-manual-fix", author="maintainer"),
        ],
        closed_pulls=[
            _workflow_pull(
                number=14,
                ref=f"{WORKFLOW_BRANCH}-manual-merged",
                author="maintainer",
                merged_at="2026-05-29T00:00:00Z",
            ),
        ],
    )

    result = _cleanup(client)

    assert client.closed_prs == []
    assert client.deleted_refs == []
    assert result.closed_prs == []
    assert result.deleted_branches == []


def test_cleanup_script_preserves_bot_prs_without_workflow_body_marker() -> None:
    """Cleanup script should not mutate bot PRs without the workflow body marker."""
    client = FakeCleanupClient(
        open_pulls=[
            _workflow_pull(
                number=15,
                ref=f"{WORKFLOW_BRANCH}-v2",
                body="Automated dependency update from another workflow.",
            ),
        ],
        closed_pulls=[
            _workflow_pull(
                number=16,
                ref=f"{WORKFLOW_BRANCH}-docs",
                body="Automated dependency update from another workflow.",
                merged_at="2026-05-29T00:00:00Z",
            ),
        ],
    )

    result = _cleanup(client)

    assert client.closed_prs == []
    assert client.deleted_refs == []
    assert result.closed_prs == []
    assert result.deleted_branches == []


def test_github_headers_include_json_content_type() -> None:
    """GitHub client headers should describe JSON request bodies correctly."""
    headers = cleanup._github_headers("token")

    assert headers["Content-Type"] == "application/json"


def test_github_client_list_refs_treats_missing_prefix_as_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """GitHub client should treat a missing matching-ref prefix as no refs."""

    def fake_urlopen(*_args: object, **_kwargs: object) -> object:
        """Raise a GitHub-style 404 response for missing refs."""
        raise HTTPError(
            url="https://api.github.test/repos/o/r/git/matching-refs/heads/missing",
            code=404,
            msg="Not Found",
            hdrs=Message(),
            fp=BytesIO(b'{"message": "Not Found"}'),
        )

    monkeypatch.setattr(cleanup, "urlopen", fake_urlopen)
    client = cleanup.GithubClient(repository=REPOSITORY, token="token")

    assert client.list_branches(ref_prefix="heads/missing") == []


def test_main_returns_failure_for_github_request_errors(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """CLI entry point should convert GitHub network failures into exit code 1."""

    def fail_cleanup(**_kwargs: object) -> object:
        """Raise a network error from the cleanup routine."""
        raise URLError("timed out")

    monkeypatch.setenv("GITHUB_TOKEN", "token")
    monkeypatch.setattr(cleanup, "cleanup_update_branches", fail_cleanup)

    with caplog.at_level("ERROR"):
        exit_code = cleanup.main(
            [
                "--repository",
                REPOSITORY,
                "--branch",
                WORKFLOW_BRANCH,
                "--branch-prefix",
                WORKFLOW_BRANCH,
                "--label-name",
                WORKFLOW_LABEL,
            ]
        )

    assert exit_code == 1
    assert (
        f"Failed to clean prek update branches for {REPOSITORY} branch {WORKFLOW_BRANCH}"
        in caplog.text
    )

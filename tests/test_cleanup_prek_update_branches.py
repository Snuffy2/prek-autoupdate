"""Tests for prek autoupdate branch cleanup."""

from __future__ import annotations

from email.message import Message
from io import BytesIO
from typing import TYPE_CHECKING
from urllib.error import HTTPError, URLError

import pytest

import prek_autoupdate.cleanup_prek_update_branches as cleanup

if TYPE_CHECKING:
    from urllib.request import Request

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
        fail_on_close: bool = False,
        pull_files: dict[int, list[dict[str, object]]] | None = None,
        ref_shas: dict[str, str | None] | None = None,
        tree_entries: (dict[str, dict[str, tuple[str, str, str] | None] | None] | None) = None,
        pull_details: dict[int, list[dict[str, object]]] | None = None,
    ) -> None:
        """Initialize fake pull request state.

        Args:
            open_pulls: Pull requests to return for open PR lookups.
            closed_pulls: Pull requests to return for closed PR lookups.
            fail_on_close: Whether closing a PR should fail the test.
            pull_files: Optional fake PR number -> changed file objects map.
            ref_shas: Optional fake branch ref -> SHA map.
            tree_entries: Optional fake ref -> path-to-tree-entry map.
            pull_details: Optional successive PR detail responses by number.

        """
        self.open_pulls = open_pulls
        self.closed_pulls = closed_pulls
        self.fail_on_close = fail_on_close
        self.pull_files = {} if pull_files is None else pull_files
        self.ref_shas = {} if ref_shas is None else ref_shas
        self.tree_entries = {} if tree_entries is None else tree_entries
        self.pull_details = {} if pull_details is None else pull_details
        self.get_pull_calls: dict[int, int] = {}
        self.closed_prs: list[int] = []
        self.deleted_refs: list[str] = []

    def list_pulls(self, *, state: str) -> list[dict[str, object]]:
        """Return fake pull requests by state."""
        if state == "open":
            return self.open_pulls
        if state == "closed":
            return self.closed_pulls
        raise ValueError(f"Unsupported pull request state: {state}")

    def close_pull(self, pull_number: int) -> None:
        """Record or reject a closed pull request."""
        if self.fail_on_close:
            raise AssertionError(f"Unexpected close for PR {pull_number}")
        self.closed_prs.append(pull_number)

    def get_pull(self, pull_number: int) -> dict[str, object]:
        """Return fake pull request details."""
        if responses := self.pull_details.get(pull_number):
            call = self.get_pull_calls.get(pull_number, 0)
            self.get_pull_calls[pull_number] = call + 1
            return responses[min(call, len(responses) - 1)]
        return next(pull for pull in self.open_pulls if pull["number"] == pull_number)

    def list_pull_files(self, pull_number: int) -> list[dict[str, object]]:
        """Return fake changed files for a pull request."""
        return self.pull_files.get(pull_number, [])

    def get_tree_entries(
        self, *, paths: set[str], ref: str
    ) -> dict[str, tuple[str, str, str] | None] | None:
        """Return fake Git tree entries."""
        entries = self.tree_entries.get(ref, {})
        if entries is None:
            return None
        return {path: entries.get(path) for path in paths}

    def delete_ref(self, ref: str) -> None:
        """Record a deleted git ref."""
        self.deleted_refs.append(ref)

    def get_ref_sha(self, *, ref: str) -> str | None:
        """Return a fake branch SHA."""
        return self.ref_shas.get(ref, "sha")


def _workflow_pull(
    *,
    number: int,
    ref: str = WORKFLOW_BRANCH,
    label: str = WORKFLOW_LABEL,
    author: str = WORKFLOW_AUTHOR,
    body: str = WORKFLOW_BODY_MARKER,
    repository: str = REPOSITORY,
    merged_at: str | None = None,
    base_ref: str = "main",
    head_sha: str | None = "sha",
    changed_files: int | None = None,
) -> dict[str, object]:
    """Return a fake workflow pull request object."""
    pull: dict[str, object] = {
        "number": number,
        "merged_at": merged_at,
        "body": body,
        "base": {"ref": base_ref},
        "user": {"login": author},
        "head": {
            "ref": ref,
            "repo": {"full_name": repository},
            "sha": head_sha,
        },
        "labels": [{"name": label}],
    }
    if changed_files is not None:
        pull["changed_files"] = changed_files
    return pull


def _cleanup(
    client: FakeCleanupClient,
    *,
    keep_pr_number: int | None = None,
    keep_latest_open_pr: bool = False,
    delete_stale_branches: bool = False,
    delete_merged_branches: bool = True,
    close_obsolete_prs: bool = False,
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
        close_obsolete_prs=close_obsolete_prs,
        delete_stale_branches=delete_stale_branches,
        delete_merged_branches=delete_merged_branches,
    )


def test_cleanup_script_closes_kept_obsolete_pull_request() -> None:
    """Push cleanup should close a kept workflow PR only when it has no changes."""
    client = FakeCleanupClient(
        open_pulls=[_workflow_pull(number=18, changed_files=0)],
        closed_pulls=[],
    )

    result = _cleanup(
        client,
        keep_latest_open_pr=True,
        close_obsolete_prs=True,
    )

    assert client.closed_prs == [18]
    assert client.deleted_refs == [f"heads/{WORKFLOW_BRANCH}"]
    assert result.closed_prs == [18]
    assert result.deleted_branches == [WORKFLOW_BRANCH]


def test_cleanup_script_preserves_kept_pull_request_with_changes() -> None:
    """Push cleanup should leave a still-needed workflow PR untouched."""
    client = FakeCleanupClient(
        open_pulls=[_workflow_pull(number=18, changed_files=1)],
        closed_pulls=[],
        fail_on_close=True,
        pull_files={18: [{"filename": "prek.toml"}]},
        ref_shas={"heads/main": "base-sha"},
        tree_entries={
            "sha": {"prek.toml": ("100644", "blob", "head-blob")},
            "base-sha": {"prek.toml": ("100644", "blob", "base-blob")},
        },
    )

    result = _cleanup(
        client,
        keep_latest_open_pr=True,
        close_obsolete_prs=True,
    )

    assert client.deleted_refs == []
    assert result.closed_prs == []
    assert result.deleted_branches == []


def test_cleanup_script_closes_pull_when_changed_file_matches_current_base() -> None:
    """Push cleanup should close a PR whose patch is already present on the base."""
    client = FakeCleanupClient(
        open_pulls=[_workflow_pull(number=18, changed_files=1)],
        closed_pulls=[],
        pull_files={18: [{"filename": "prek.toml"}]},
        ref_shas={"heads/main": "base-sha"},
        tree_entries={
            "sha": {"prek.toml": ("100644", "blob", "shared-blob")},
            "base-sha": {"prek.toml": ("100644", "blob", "shared-blob")},
        },
    )

    result = _cleanup(
        client,
        keep_latest_open_pr=True,
        close_obsolete_prs=True,
    )

    assert client.closed_prs == [18]
    assert client.deleted_refs == [f"heads/{WORKFLOW_BRANCH}"]
    assert result.closed_prs == [18]
    assert result.deleted_branches == [WORKFLOW_BRANCH]


def test_cleanup_script_closes_pull_when_rename_matches_current_base() -> None:
    """Push cleanup should compare both paths from an already-applied rename."""
    client = FakeCleanupClient(
        open_pulls=[_workflow_pull(number=18, changed_files=1)],
        closed_pulls=[],
        pull_files={
            18: [
                {
                    "filename": "prek.toml",
                    "previous_filename": ".pre-commit-config.yaml",
                }
            ]
        },
        ref_shas={"heads/main": "base-sha"},
        tree_entries={
            "sha": {"prek.toml": ("100644", "blob", "shared-blob")},
            "base-sha": {"prek.toml": ("100644", "blob", "shared-blob")},
        },
    )

    result = _cleanup(
        client,
        keep_latest_open_pr=True,
        close_obsolete_prs=True,
    )

    assert client.closed_prs == [18]
    assert result.closed_prs == [18]


def test_cleanup_script_preserves_pull_when_current_base_cannot_be_resolved() -> None:
    """Push cleanup should preserve a PR when its current base is unavailable."""
    client = FakeCleanupClient(
        open_pulls=[_workflow_pull(number=18, changed_files=1)],
        closed_pulls=[],
        fail_on_close=True,
        ref_shas={"heads/main": None},
    )

    result = _cleanup(
        client,
        keep_latest_open_pr=True,
        close_obsolete_prs=True,
    )

    assert client.closed_prs == []
    assert result.closed_prs == []


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


def test_cleanup_script_preserves_prefixed_branches_without_workflow_metadata() -> None:
    """Prefixed branches without workflow PR metadata are preserved."""
    client = FakeCleanupClient(
        open_pulls=[_workflow_pull(number=18)],
        closed_pulls=[],
    )

    result = _cleanup(
        client,
        keep_pr_number=18,
        delete_stale_branches=True,
        delete_merged_branches=False,
    )

    assert client.deleted_refs == []
    assert result.deleted_branches == []


def test_cleanup_script_deletes_closed_unmerged_workflow_branches_with_sha_match() -> None:
    """Closed unmerged workflow PR branches are deleted when ownership and SHA match."""
    stale_branch = f"{WORKFLOW_BRANCH}-manual"
    client = FakeCleanupClient(
        open_pulls=[_workflow_pull(number=18)],
        closed_pulls=[_workflow_pull(number=7, ref=stale_branch)],
    )

    result = _cleanup(
        client,
        keep_pr_number=18,
        delete_stale_branches=True,
        delete_merged_branches=False,
    )

    assert client.deleted_refs == [f"heads/{stale_branch}"]
    assert result.deleted_branches == [stale_branch]


def test_cleanup_script_preserves_merged_workflow_branch_when_sha_differs() -> None:
    """Merged workflow PR branches are preserved when branch SHA has moved."""
    stale_branch = f"{WORKFLOW_BRANCH}-merged-different"
    client = FakeCleanupClient(
        open_pulls=[],
        closed_pulls=[
            _workflow_pull(
                number=7,
                ref=stale_branch,
                merged_at="2026-05-28T00:00:00Z",
            )
        ],
        ref_shas={f"heads/{stale_branch}": "mismatched-sha"},
    )

    result = _cleanup(client)

    assert client.deleted_refs == []
    assert result.deleted_branches == []


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
    )

    result = _cleanup(
        client,
        keep_latest_open_pr=True,
        delete_stale_branches=True,
        delete_merged_branches=False,
    )

    assert client.deleted_refs == []
    assert result.deleted_branches == []


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

    result = _cleanup(client, close_obsolete_prs=True)

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


def test_github_client_closes_and_gets_pull(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """GitHub client should use the pull endpoint for mutations and details."""
    calls: list[tuple[str, str, dict[str, str] | None]] = []
    pull = _workflow_pull(number=18)

    def fake_request(
        method: str,
        url: str,
        *,
        payload: dict[str, str] | None = None,
    ) -> tuple[object, None]:
        """Record GitHub requests and return pull details."""
        calls.append((method, url, payload))
        return pull, None

    client = cleanup.GithubClient(repository=REPOSITORY, token="token")
    monkeypatch.setattr(client, "_request", fake_request)

    client.close_pull(18)
    assert client.get_pull(18) == pull
    assert calls == [
        (
            "PATCH",
            "https://api.github.com/repos/o/r/pulls/18",
            {"state": "closed"},
        ),
        ("GET", "https://api.github.com/repos/o/r/pulls/18", None),
    ]


def test_github_client_lists_pull_files_across_pages(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """GitHub client should follow pagination when listing pull request files."""
    calls: list[str] = []
    next_url = "https://api.github.com/repositories/1/pulls/18/files?per_page=100&page=2"

    def fake_request(method: str, url: str) -> tuple[object, str | None]:
        """Return two fake pages of pull request files."""
        assert method == "GET"
        calls.append(url)
        if len(calls) == 1:
            return [{"filename": "prek.toml"}], f'<{next_url}>; rel="next"'
        return [{"filename": "README.md"}], None

    client = cleanup.GithubClient(repository=REPOSITORY, token="token")
    monkeypatch.setattr(client, "_request", fake_request)

    assert client.list_pull_files(18) == [
        {"filename": "prek.toml"},
        {"filename": "README.md"},
    ]
    assert calls == [
        "https://api.github.com/repos/o/r/pulls/18/files?per_page=100",
        next_url,
    ]


@pytest.mark.parametrize(
    ("payload", "message"),
    [
        ({}, "Expected pull request file list"),
        ([None], "Expected pull request file object"),
    ],
)
def test_github_client_rejects_invalid_pull_file_list(
    monkeypatch: pytest.MonkeyPatch,
    payload: object,
    message: str,
) -> None:
    """GitHub client should reject malformed pull files responses."""
    client = cleanup.GithubClient(repository=REPOSITORY, token="token")
    monkeypatch.setattr(client, "_request", lambda *_args: (payload, None))

    with pytest.raises(TypeError, match=message):
        client.list_pull_files(18)


def test_github_client_gets_tree_entry_identities(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """GitHub client should return full identities and absent requested paths."""
    calls: list[str] = []

    def fake_request(method: str, url: str) -> tuple[object, None]:
        """Return a recursive Git tree."""
        assert method == "GET"
        calls.append(url)
        return {
            "truncated": False,
            "tree": [
                {
                    "path": "config/prek #1.toml",
                    "mode": "100644",
                    "type": "blob",
                    "sha": "blob-sha",
                },
                {
                    "path": "unrequested.toml",
                    "mode": "100644",
                    "type": "blob",
                    "sha": "other-sha",
                },
            ],
        }, None

    client = cleanup.GithubClient(repository=REPOSITORY, token="token")
    monkeypatch.setattr(client, "_request", fake_request)

    assert client.get_tree_entries(paths={"config/prek #1.toml", "missing.toml"}, ref="head#1") == {
        "config/prek #1.toml": ("100644", "blob", "blob-sha"),
        "missing.toml": None,
    }
    assert calls == [
        "https://api.github.com/repos/o/r/git/trees/head%231?recursive=1",
    ]


@pytest.mark.parametrize(
    ("payload", "message"),
    [
        ([], "Expected a Git tree object"),
        ({}, "Expected a Git tree list"),
        ({"tree": [None]}, "Expected a Git tree entry"),
        (
            {"tree": [{"path": "prek.toml", "mode": "100644", "type": "blob"}]},
            "Expected a complete Git tree entry",
        ),
    ],
)
def test_github_client_rejects_invalid_tree_payload(
    monkeypatch: pytest.MonkeyPatch,
    payload: object,
    message: str,
) -> None:
    """GitHub client should reject malformed Git tree responses."""
    client = cleanup.GithubClient(repository=REPOSITORY, token="token")
    monkeypatch.setattr(client, "_request", lambda *_args: (payload, None))

    with pytest.raises(TypeError, match=message):
        client.get_tree_entries(paths={"prek.toml"}, ref="sha")


def test_github_client_preserves_on_truncated_tree(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """GitHub client should mark a truncated recursive tree unusable."""
    client = cleanup.GithubClient(repository=REPOSITORY, token="token")
    monkeypatch.setattr(client, "_request", lambda *_args: ({"truncated": True}, None))

    assert client.get_tree_entries(paths={"prek.toml"}, ref="sha") is None


def test_github_client_rejects_invalid_pull_payload(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """GitHub client should reject non-object pull details."""
    client = cleanup.GithubClient(repository=REPOSITORY, token="token")
    monkeypatch.setattr(client, "_request", lambda *_args: ([], None))

    with pytest.raises(TypeError, match="Expected a pull request object"):
        client.get_pull(18)


def test_pull_metadata_rejects_invalid_numeric_values() -> None:
    """Pull metadata helpers should reject invalid number and file counts."""
    with pytest.raises(TypeError, match="numeric number"):
        cleanup._pull_number({"number": None})

    with pytest.raises(TypeError, match="valid changed file count"):
        cleanup._pull_changed_files({"changed_files": -1})


@pytest.mark.parametrize(
    "files",
    [
        [{}],
        [{"filename": "prek.toml", "previous_filename": 1}],
    ],
)
def test_pull_file_paths_reject_invalid_names(
    files: list[dict[str, object]],
) -> None:
    """Pull file path extraction should reject malformed API objects."""
    with pytest.raises(TypeError, match="filename"):
        cleanup._pull_file_paths(files)


@pytest.mark.parametrize(
    "details",
    [
        _workflow_pull(number=18, head_sha=None, changed_files=1),
        {**_workflow_pull(number=18, changed_files=1), "base": {}},
        {**_workflow_pull(number=18, changed_files=1), "base": None},
    ],
)
def test_pull_is_not_obsolete_without_comparison_refs(
    details: dict[str, object],
) -> None:
    """Obsolete detection should preserve PRs without usable comparison refs."""
    client = FakeCleanupClient(open_pulls=[details], closed_pulls=[])

    assert not cleanup._pull_is_obsolete(client, details)


def test_pull_is_not_obsolete_when_changed_file_list_is_empty() -> None:
    """Obsolete detection should not infer equality from a missing file list."""
    pull = _workflow_pull(number=18, changed_files=1)
    client = FakeCleanupClient(
        open_pulls=[pull],
        closed_pulls=[],
        ref_shas={"heads/main": "base-sha"},
    )

    assert not cleanup._pull_is_obsolete(client, pull)


def test_pull_is_not_obsolete_when_file_listing_is_incomplete() -> None:
    """Obsolete detection should preserve PRs when GitHub omits changed files."""
    pull = _workflow_pull(number=18, changed_files=2)
    client = FakeCleanupClient(
        open_pulls=[pull],
        closed_pulls=[],
        pull_files={18: [{"filename": "prek.toml"}]},
        ref_shas={"heads/main": "base-sha"},
    )

    assert not cleanup._pull_is_obsolete(client, pull)


def test_pull_is_not_obsolete_when_head_changes_during_comparison() -> None:
    """Obsolete detection should preserve PRs whose head moves mid-check."""
    pull = _workflow_pull(number=18, changed_files=1)
    moved = _workflow_pull(number=18, head_sha="new-sha", changed_files=1)
    client = FakeCleanupClient(
        open_pulls=[pull],
        closed_pulls=[],
        pull_files={18: [{"filename": "prek.toml"}]},
        ref_shas={"heads/main": "base-sha"},
        tree_entries={
            "sha": {"prek.toml": ("100644", "blob", "shared")},
            "base-sha": {"prek.toml": ("100644", "blob", "shared")},
        },
        pull_details={18: [pull, moved]},
    )

    assert not cleanup._pull_is_obsolete(client, pull)


@pytest.mark.parametrize(
    ("head_entry", "base_entry"),
    [
        (("100755", "blob", "shared"), ("100644", "blob", "shared")),
        (("040000", "tree", "shared"), ("100644", "blob", "shared")),
    ],
)
def test_pull_is_not_obsolete_when_tree_entry_identity_differs(
    head_entry: tuple[str, str, str],
    base_entry: tuple[str, str, str],
) -> None:
    """Obsolete detection should compare mode and type as well as SHA."""
    pull = _workflow_pull(number=18, changed_files=1)
    client = FakeCleanupClient(
        open_pulls=[pull],
        closed_pulls=[],
        pull_files={18: [{"filename": "prek.toml"}]},
        ref_shas={"heads/main": "base-sha"},
        tree_entries={
            "sha": {"prek.toml": head_entry},
            "base-sha": {"prek.toml": base_entry},
        },
    )

    assert not cleanup._pull_is_obsolete(client, pull)


def test_pull_is_not_obsolete_when_tree_is_truncated() -> None:
    """Obsolete detection should preserve PRs with unusable tree data."""
    pull = _workflow_pull(number=18, changed_files=1)
    client = FakeCleanupClient(
        open_pulls=[pull],
        closed_pulls=[],
        pull_files={18: [{"filename": "prek.toml"}]},
        ref_shas={"heads/main": "base-sha"},
        tree_entries={"sha": None},
    )

    assert not cleanup._pull_is_obsolete(client, pull)


def test_pull_is_not_obsolete_when_base_moves_during_comparison() -> None:
    """Obsolete detection should preserve PRs whose base branch moves mid-check."""
    pull = _workflow_pull(number=18, changed_files=1)

    class MovingBaseClient(FakeCleanupClient):
        """Fake client whose base ref moves after its first lookup."""

        def get_ref_sha(self, *, ref: str) -> str | None:
            """Return a different base SHA on the second lookup."""
            current = super().get_ref_sha(ref=ref)
            self.ref_shas[ref] = "new-base-sha"
            return current

    client = MovingBaseClient(
        open_pulls=[pull],
        closed_pulls=[],
        pull_files={18: [{"filename": "prek.toml"}]},
        ref_shas={"heads/main": "base-sha"},
        tree_entries={
            "sha": {"prek.toml": ("100644", "blob", "shared")},
            "base-sha": {"prek.toml": ("100644", "blob", "shared")},
        },
    )

    assert not cleanup._pull_is_obsolete(client, pull)


def test_workflow_pull_preserves_explicit_missing_head_sha() -> None:
    """The workflow pull fixture should preserve an explicit None head SHA."""
    pull = _workflow_pull(number=18, head_sha=None)

    assert pull["head"] == {
        "ref": WORKFLOW_BRANCH,
        "repo": {"full_name": REPOSITORY},
        "sha": None,
    }


def test_main_logs_successful_cleanup(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """CLI entry point should report successful cleanup results."""
    monkeypatch.setenv("GITHUB_TOKEN", "token")
    monkeypatch.setattr(
        cleanup,
        "cleanup_update_branches",
        lambda **_kwargs: cleanup.CleanupResult(
            closed_prs=[18],
            deleted_branches=[WORKFLOW_BRANCH],
        ),
    )

    with caplog.at_level("INFO"):
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

    assert exit_code == 0
    assert "Closed PRs: [18]" in caplog.text
    assert f"Deleted branches: ['{WORKFLOW_BRANCH}']" in caplog.text


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


def test_github_client_delete_ref_urlencodes_reserved_chars(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Delete calls should URL-encode reserved characters in refs."""
    calls: list[str] = []

    def fake_urlopen(request: Request, *_args: object, **_kwargs: object) -> object:
        url = request.full_url
        calls.append(url)
        raise HTTPError(
            url=url,
            code=404,
            msg="Not Found",
            hdrs=Message(),
            fp=BytesIO(b'{"message": "Not Found"}'),
        )

    monkeypatch.setattr(cleanup, "urlopen", fake_urlopen)
    client = cleanup.GithubClient(repository=REPOSITORY, token="token")
    client.delete_ref("heads/feature#1")

    assert calls == ["https://api.github.com/repos/o/r/git/refs/heads/feature%231"]

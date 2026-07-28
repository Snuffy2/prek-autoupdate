"""Tests for prek autoupdate branch cleanup."""

from __future__ import annotations

import base64
import hmac
import subprocess
from typing import TYPE_CHECKING
from urllib.error import URLError

import pytest

import prek_autoupdate.cleanup_prek_update_branches as cleanup

if TYPE_CHECKING:
    from pathlib import Path

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
        comparison_files: (dict[tuple[str, str], list[dict[str, object]]] | None) = None,
        ref_shas: dict[str, str | None] | None = None,
        tree_entries: (dict[str, dict[str, tuple[str, str, str] | None] | None] | None) = None,
        pull_details: dict[int, list[dict[str, object]]] | None = None,
    ) -> None:
        """Initialize fake pull request state.

        Args:
            open_pulls: Pull requests to return for open PR lookups.
            closed_pulls: Pull requests to return for closed PR lookups.
            fail_on_close: Whether closing a PR should fail the test.
            comparison_files: Optional comparison SHA pair -> changed files map.
            ref_shas: Optional fake branch ref -> SHA map.
            tree_entries: Optional fake ref -> path-to-tree-entry map.
            pull_details: Optional successive PR detail responses by number.

        """
        self.open_pulls = open_pulls
        self.closed_pulls = closed_pulls
        self.fail_on_close = fail_on_close
        self.comparison_files = {} if comparison_files is None else comparison_files
        self.ref_shas = {} if ref_shas is None else ref_shas
        self.tree_entries = {} if tree_entries is None else tree_entries
        self.pull_details = {} if pull_details is None else pull_details
        self.get_pull_calls: dict[int, int] = {}
        self.pull_states: dict[int, str] = {
            cleanup._pull_number(pull): "open" for pull in open_pulls
        }
        self.pull_states.update({cleanup._pull_number(pull): "closed" for pull in closed_pulls})
        self.close_responses: dict[int, dict[str, object]] = {}
        self.closed_prs: list[int] = []
        self.reopened_prs: list[int] = []
        self.deleted_refs: list[str] = []

    def list_pulls(self, *, state: str) -> list[dict[str, object]]:
        """Return fake pull requests by state."""
        if state == "open":
            return self.open_pulls
        if state == "closed":
            return self.closed_pulls
        raise ValueError(f"Unsupported pull request state: {state}")

    def close_pull(self, pull_number: int) -> dict[str, object]:
        """Record a close and return its mutation identity payload."""
        if self.fail_on_close:
            raise AssertionError(f"Unexpected close for PR {pull_number}")
        pull = self.get_pull(pull_number)
        self.closed_prs.append(pull_number)
        self.pull_states[pull_number] = "closed"
        response = {
            **pull,
            "state": "closed",
            "changed_files": pull.get("changed_files", 0),
            "updated_at": "2026-07-27T12:00:00Z",
        }
        self.close_responses[pull_number] = response
        return response

    def reopen_pull(self, pull_number: int) -> None:
        """Record a reopened pull request."""
        self.reopened_prs.append(pull_number)
        self.pull_states[pull_number] = "open"

    def get_pull(self, pull_number: int) -> dict[str, object]:
        """Return fake pull request details."""
        if responses := self.pull_details.get(pull_number):
            call = self.get_pull_calls.get(pull_number, 0)
            self.get_pull_calls[pull_number] = call + 1
            pull = responses[min(call, len(responses) - 1)]
        else:
            pull = next(
                pull
                for pull in [*self.open_pulls, *self.closed_pulls]
                if pull["number"] == pull_number
            )
        refreshed = {**pull, "state": self.pull_states[pull_number]}
        if refreshed["state"] == "closed" and pull_number in self.close_responses:
            refreshed.setdefault(
                "changed_files", self.close_responses[pull_number]["changed_files"]
            )
            refreshed.setdefault("updated_at", self.close_responses[pull_number]["updated_at"])
        return refreshed

    def compare_files(self, *, base_sha: str, head_sha: str) -> list[dict[str, object]]:
        """Return fake files for an immutable comparison."""
        return self.comparison_files.get((base_sha, head_sha), [])

    def get_tree_entries(
        self, *, paths: set[str], ref: str
    ) -> dict[str, tuple[str, str, str] | None] | None:
        """Return fake Git tree entries."""
        entries = self.tree_entries.get(ref, {})
        if entries is None:
            return None
        return {path: entries.get(path) for path in paths}

    def delete_ref(self, ref: str, *, expected_sha: str) -> cleanup.DeleteRefOutcome:
        """Record a lease-guarded deleted git ref."""
        current_sha = self.get_ref_sha(ref=ref)
        if current_sha is None:
            return cleanup.DeleteRefOutcome.ALREADY_ABSENT
        if current_sha != expected_sha:
            return cleanup.DeleteRefOutcome.LEASE_REJECTED
        self.deleted_refs.append(ref)
        self.ref_shas[ref] = None
        return cleanup.DeleteRefOutcome.DELETED

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
    close_stale_prs: bool = True,
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
        close_stale_prs=close_stale_prs,
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
    assert client.deleted_refs == []
    assert result.closed_prs == [18]
    assert result.deleted_branches == []


def test_cleanup_script_preserves_kept_pull_request_with_changes() -> None:
    """Push cleanup should leave a still-needed workflow PR untouched."""
    client = FakeCleanupClient(
        open_pulls=[_workflow_pull(number=18, changed_files=1)],
        closed_pulls=[],
        fail_on_close=True,
        comparison_files={("base-sha", "sha"): [{"filename": "prek.toml"}]},
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
        comparison_files={("base-sha", "sha"): [{"filename": "prek.toml"}]},
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
    assert client.deleted_refs == []
    assert result.closed_prs == [18]
    assert result.deleted_branches == []


def test_cleanup_script_reopens_obsolete_pull_when_base_moves_before_close() -> None:
    """Cleanup should compensate when the base moves immediately before close."""
    pull = _workflow_pull(number=18, changed_files=1)

    class MovingBaseOnCloseClient(FakeCleanupClient):
        """Fake client whose base ref moves as the pull is closed."""

        def close_pull(self, pull_number: int) -> dict[str, object]:
            """Record the close and move the base before post-close validation."""
            response = super().close_pull(pull_number)
            self.ref_shas["heads/main"] = "new-base-sha"
            return response

    client = MovingBaseOnCloseClient(
        open_pulls=[pull],
        closed_pulls=[],
        comparison_files={("base-sha", "sha"): [{"filename": "prek.toml"}]},
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
    assert client.reopened_prs == [18]
    assert client.deleted_refs == []
    assert result.closed_prs == []
    assert result.deleted_branches == []


def test_cleanup_script_preserves_pull_when_post_close_state_is_open() -> None:
    """Cleanup should not reopen a pull whose close identity no longer matches."""
    pull = _workflow_pull(number=18, changed_files=0)

    class StillOpenAfterCloseClient(FakeCleanupClient):
        """Fake client that reports the pull open after the close mutation."""

        def close_pull(self, pull_number: int) -> dict[str, object]:
            """Record the close but keep the refreshed pull state open."""
            response = super().close_pull(pull_number)
            self.pull_states[pull_number] = "open"
            return response

    client = StillOpenAfterCloseClient(open_pulls=[pull], closed_pulls=[])

    result = _cleanup(
        client,
        keep_latest_open_pr=True,
        close_obsolete_prs=True,
    )

    assert client.closed_prs == [18]
    assert client.reopened_prs == []
    assert client.deleted_refs == []
    assert result.closed_prs == []
    assert result.deleted_branches == []


@pytest.mark.parametrize("cleanup_mode", ["stale", "obsolete"])
def test_cleanup_script_preserves_when_close_identity_is_incomplete(
    cleanup_mode: str,
) -> None:
    """Cleanup should not reopen or delete without close mutation evidence."""
    pull = _workflow_pull(number=18, changed_files=0)

    class IncompleteCloseResponseClient(FakeCleanupClient):
        """Fake client whose close response lacks mutation evidence."""

        def close_pull(self, pull_number: int) -> dict[str, object]:
            """Remove updated_at from the otherwise successful close response."""
            response = super().close_pull(pull_number)
            response.pop("updated_at")
            return response

    client = IncompleteCloseResponseClient(open_pulls=[pull], closed_pulls=[])

    result = _cleanup(client, close_obsolete_prs=cleanup_mode == "obsolete")

    assert client.reopened_prs == []
    assert client.deleted_refs == []
    assert result.closed_prs == []
    assert result.deleted_branches == []


def test_cleanup_script_rechecks_label_before_obsolete_close() -> None:
    """Cleanup should not close a PR whose ownership label was removed."""
    pull = _workflow_pull(number=18, changed_files=0)
    without_label = _workflow_pull(number=18, changed_files=0, label="other")
    client = FakeCleanupClient(
        open_pulls=[pull],
        closed_pulls=[],
        pull_details={18: [pull, pull, without_label]},
    )

    result = _cleanup(client, close_obsolete_prs=True)

    assert client.closed_prs == []
    assert client.deleted_refs == []
    assert result.closed_prs == []


def test_cleanup_script_rechecks_label_before_stale_close() -> None:
    """Cleanup should preserve a stale PR whose ownership label was removed."""
    pull = _workflow_pull(number=18)
    without_label = _workflow_pull(number=18, label="other")
    client = FakeCleanupClient(
        open_pulls=[pull],
        closed_pulls=[],
        pull_details={18: [without_label]},
    )

    result = _cleanup(client)

    assert client.closed_prs == []
    assert client.deleted_refs == []
    assert result.closed_prs == []


def test_cleanup_script_rejects_close_response_without_body_marker() -> None:
    """Cleanup should not accept a close response that lost workflow ownership."""
    pull = _workflow_pull(number=18, changed_files=0)

    class RemovedBodyOnCloseClient(FakeCleanupClient):
        """Fake client whose close response has no workflow marker."""

        def close_pull(self, pull_number: int) -> dict[str, object]:
            """Return a closed payload with independently changed body text."""
            response = super().close_pull(pull_number)
            response["body"] = "Changed by another actor"
            return response

    client = RemovedBodyOnCloseClient(open_pulls=[pull], closed_pulls=[])

    result = _cleanup(client, close_obsolete_prs=True)

    assert client.closed_prs == [18]
    assert client.reopened_prs == [18]
    assert client.deleted_refs == []
    assert result.closed_prs == []


def test_cleanup_script_rejects_stale_close_response_without_body_marker() -> None:
    """Cleanup should reject stale-close evidence that lost workflow ownership."""
    pull = _workflow_pull(number=18)

    class RemovedBodyOnCloseClient(FakeCleanupClient):
        """Fake client whose close response has no workflow marker."""

        def close_pull(self, pull_number: int) -> dict[str, object]:
            """Return a closed payload with independently changed body text."""
            response = super().close_pull(pull_number)
            response["body"] = "Changed by another actor"
            return response

    client = RemovedBodyOnCloseClient(open_pulls=[pull], closed_pulls=[])

    result = _cleanup(client)

    assert client.closed_prs == [18]
    assert client.reopened_prs == [18]
    assert client.deleted_refs == []
    assert result.closed_prs == []


def test_cleanup_script_protects_compensated_branch_from_closed_listing() -> None:
    """A reopened pull branch should survive an eventually consistent closed listing."""
    pull = _workflow_pull(number=18, changed_files=1)

    class MovingBaseOnCloseClient(FakeCleanupClient):
        """Fake client whose base ref moves as the pull is closed."""

        def close_pull(self, pull_number: int) -> dict[str, object]:
            """Record the close and move the base before post-close validation."""
            response = super().close_pull(pull_number)
            self.ref_shas["heads/main"] = "new-base-sha"
            return response

    client = MovingBaseOnCloseClient(
        open_pulls=[pull],
        closed_pulls=[pull],
        comparison_files={("base-sha", "sha"): [{"filename": "prek.toml"}]},
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
        delete_stale_branches=True,
    )

    assert client.reopened_prs == [18]
    assert client.deleted_refs == []
    assert result.closed_prs == []
    assert result.deleted_branches == []


def test_cleanup_script_reopens_when_head_moves_after_post_close_snapshot() -> None:
    """A moved head should compensate even when a closed listing advertises it."""
    pull = _workflow_pull(number=18, changed_files=0)
    moved = _workflow_pull(number=18, head_sha="new-sha")

    class MovingHeadAfterSnapshotClient(FakeCleanupClient):
        """Fake client whose branch moves before the immediate head check."""

        def get_ref_sha(self, *, ref: str) -> str | None:
            """Return the moved SHA for the PR head branch."""
            if ref == f"heads/{WORKFLOW_BRANCH}":
                return "new-sha"
            return super().get_ref_sha(ref=ref)

    client = MovingHeadAfterSnapshotClient(
        open_pulls=[pull],
        closed_pulls=[moved],
    )

    result = _cleanup(
        client,
        keep_latest_open_pr=True,
        close_obsolete_prs=True,
        delete_stale_branches=True,
    )

    assert client.reopened_prs == [18]
    assert client.deleted_refs == []
    assert result.closed_prs == []
    assert result.deleted_branches == []


def test_cleanup_script_defers_obsolete_branch_deletion() -> None:
    """A just-closed obsolete pull branch should be protected until a later run."""
    pull = _workflow_pull(number=18, changed_files=0)

    class MovingHeadBeforeDeleteClient(FakeCleanupClient):
        """Fake client whose branch moves after its immediate validation."""

        head_ref_calls = 0

        def get_ref_sha(self, *, ref: str) -> str | None:
            """Move the head on the final pre-delete lookup."""
            if ref == f"heads/{WORKFLOW_BRANCH}":
                self.head_ref_calls += 1
                return "sha" if self.head_ref_calls == 1 else "new-sha"
            return super().get_ref_sha(ref=ref)

    client = MovingHeadBeforeDeleteClient(
        open_pulls=[pull],
        closed_pulls=[],
    )

    result = _cleanup(
        client,
        keep_latest_open_pr=True,
        close_obsolete_prs=True,
    )

    assert client.reopened_prs == []
    assert client.deleted_refs == []
    assert result.closed_prs == [18]
    assert result.deleted_branches == []


@pytest.mark.parametrize(
    ("updated_at", "merged_at"),
    [
        ("2026-07-27T12:01:00Z", None),
        ("2026-07-27T12:01:00Z", "2026-07-27T12:00:30Z"),
    ],
)
def test_cleanup_script_does_not_reopen_concurrently_changed_pull(
    updated_at: str,
    merged_at: str | None,
) -> None:
    """Deferred deletion should avoid later same-run compensation races."""
    pull = _workflow_pull(number=18, changed_files=0)

    class ConcurrentTransitionClient(FakeCleanupClient):
        """Fake client whose PR changes before final compensation."""

        head_ref_calls = 0
        concurrently_changed = False

        def get_ref_sha(self, *, ref: str) -> str | None:
            """Move the head before final deletion and expose the concurrent PR."""
            if ref == f"heads/{WORKFLOW_BRANCH}":
                self.head_ref_calls += 1
                if self.head_ref_calls > 1:
                    self.concurrently_changed = True
                    return "new-sha"
            return super().get_ref_sha(ref=ref)

        def get_pull(self, pull_number: int) -> dict[str, object]:
            """Return a concurrent closed update or merge during compensation."""
            if self.concurrently_changed:
                return {
                    **_workflow_pull(
                        number=pull_number,
                        changed_files=0,
                        merged_at=merged_at,
                    ),
                    "state": "closed",
                    "updated_at": updated_at,
                }
            return super().get_pull(pull_number)

    client = ConcurrentTransitionClient(open_pulls=[pull], closed_pulls=[])

    result = _cleanup(client, close_obsolete_prs=True)

    assert client.reopened_prs == []
    assert client.deleted_refs == []
    assert result.closed_prs == [18]
    assert result.deleted_branches == []


def test_cleanup_script_reopens_all_shared_head_pulls_on_final_mismatch() -> None:
    """Same-revision shared-head candidates should aggregate compensation PRs."""
    pulls = [
        _workflow_pull(number=18, base_ref="main", changed_files=0),
        _workflow_pull(number=19, base_ref="develop", changed_files=0),
    ]

    class MovingSharedHeadClient(FakeCleanupClient):
        """Fake client whose shared head moves before final deletion."""

        head_ref_calls = 0
        immediate_checks = len(pulls)

        def get_ref_sha(self, *, ref: str) -> str | None:
            """Move the shared head after both immediate checks."""
            if ref == f"heads/{WORKFLOW_BRANCH}":
                self.head_ref_calls += 1
                return "sha" if self.head_ref_calls <= self.immediate_checks else "new-sha"
            return super().get_ref_sha(ref=ref)

    client = MovingSharedHeadClient(open_pulls=pulls, closed_pulls=[])

    result = _cleanup(client, close_obsolete_prs=True)

    assert client.reopened_prs == []
    assert client.deleted_refs == []
    assert result.closed_prs == [18, 19]
    assert result.deleted_branches == []


def test_cleanup_script_compensates_conflicting_shared_head_candidates() -> None:
    """Different expected SHAs for one head should reopen every affected pull."""
    pulls = [
        _workflow_pull(number=18, base_ref="main", head_sha="old-sha", changed_files=0),
        _workflow_pull(number=19, base_ref="develop", head_sha="new-sha", changed_files=0),
    ]

    class AdvancingSharedHeadClient(FakeCleanupClient):
        """Fake client whose shared branch advances between pull checks."""

        head_ref_calls = 0

        def get_ref_sha(self, *, ref: str) -> str | None:
            """Return each pull's expected SHA at its immediate check."""
            if ref == f"heads/{WORKFLOW_BRANCH}":
                self.head_ref_calls += 1
                return "old-sha" if self.head_ref_calls == 1 else "new-sha"
            return super().get_ref_sha(ref=ref)

    client = AdvancingSharedHeadClient(open_pulls=pulls, closed_pulls=[])

    result = _cleanup(client, close_obsolete_prs=True)

    assert client.reopened_prs == []
    assert client.deleted_refs == []
    assert result.closed_prs == [18, 19]
    assert result.deleted_branches == []


def test_conflicting_branch_deletion_evidence_protects_branch() -> None:
    """Conflicting expected revisions should cancel a queued deletion."""
    branches_to_delete = {WORKFLOW_BRANCH: cleanup.BranchDeletion("old-sha", frozenset({18}))}
    protected_branches: set[str] = set()

    cleanup._queue_branch_deletion(
        branches_to_delete=branches_to_delete,
        protected_branches=protected_branches,
        branch_name=WORKFLOW_BRANCH,
        deletion=cleanup.BranchDeletion("old-sha", frozenset({19})),
    )

    assert branches_to_delete == {
        WORKFLOW_BRANCH: cleanup.BranchDeletion("old-sha", frozenset({18, 19}))
    }

    cleanup._queue_branch_deletion(
        branches_to_delete=branches_to_delete,
        protected_branches=protected_branches,
        branch_name=WORKFLOW_BRANCH,
        deletion=cleanup.BranchDeletion("new-sha", frozenset({20})),
    )

    assert branches_to_delete == {}
    assert protected_branches == {WORKFLOW_BRANCH}


def test_cleanup_script_preserves_on_post_close_validation_error() -> None:
    """An unprovable post-close state should preserve without blind reopen."""
    pull = _workflow_pull(number=18, changed_files=0)

    class InvalidPostClosePullClient(FakeCleanupClient):
        """Fake client whose post-close pull payload is invalid."""

        closed = False

        def close_pull(self, pull_number: int) -> dict[str, object]:
            """Record that subsequent pull validation should fail."""
            response = super().close_pull(pull_number)
            self.closed = True
            return response

        def get_pull(self, pull_number: int) -> dict[str, object]:
            """Raise for the first pull read after closing."""
            if self.closed:
                raise TypeError("Malformed pull response")
            return super().get_pull(pull_number)

    client = InvalidPostClosePullClient(open_pulls=[pull], closed_pulls=[])

    with pytest.raises(TypeError, match="Malformed pull response"):
        _cleanup(client, close_obsolete_prs=True)

    assert client.reopened_prs == []
    assert client.deleted_refs == []


def test_cleanup_script_preserves_on_ambiguous_close_timeout() -> None:
    """A close without mutation identity should not be blindly reopened."""
    pull = _workflow_pull(number=18, changed_files=0)

    class TimedOutCloseClient(FakeCleanupClient):
        """Fake client whose close times out after recording the mutation."""

        def close_pull(self, pull_number: int) -> dict[str, object]:
            """Record the possibly completed close and time out."""
            super().close_pull(pull_number)
            raise TimeoutError("close timed out")

    client = TimedOutCloseClient(open_pulls=[pull], closed_pulls=[])

    with pytest.raises(TimeoutError, match="close timed out"):
        _cleanup(client, close_obsolete_prs=True)

    assert client.reopened_prs == []
    assert client.deleted_refs == []


def test_cleanup_script_preserves_on_post_close_validation_timeout() -> None:
    """A post-close timeout should preserve without blind reopen."""
    pull = _workflow_pull(number=18, changed_files=0)

    class TimedOutPostCloseClient(FakeCleanupClient):
        """Fake client whose post-close pull refresh times out."""

        closed = False

        def close_pull(self, pull_number: int) -> dict[str, object]:
            """Record the close before enabling the timeout."""
            response = super().close_pull(pull_number)
            self.closed = True
            return response

        def get_pull(self, pull_number: int) -> dict[str, object]:
            """Time out after the close mutation."""
            if self.closed:
                raise TimeoutError("validation timed out")
            return super().get_pull(pull_number)

    client = TimedOutPostCloseClient(open_pulls=[pull], closed_pulls=[])

    with pytest.raises(TimeoutError, match="validation timed out"):
        _cleanup(client, close_obsolete_prs=True)

    assert client.reopened_prs == []
    assert client.deleted_refs == []


def test_cleanup_script_compensates_final_ref_lookup_error() -> None:
    """A final ref lookup error should reopen before propagating."""
    pull = _workflow_pull(number=18, changed_files=0)

    class FailingFinalLookupClient(FakeCleanupClient):
        """Fake client whose head lookup fails during final validation."""

        head_ref_calls = 0

        def get_ref_sha(self, *, ref: str) -> str | None:
            """Fail the second head lookup."""
            if ref == f"heads/{WORKFLOW_BRANCH}":
                self.head_ref_calls += 1
                if self.head_ref_calls > 1:
                    raise URLError("lookup failed")
            return super().get_ref_sha(ref=ref)

    client = FailingFinalLookupClient(open_pulls=[pull], closed_pulls=[])

    result = _cleanup(client, close_obsolete_prs=True)

    assert client.reopened_prs == []
    assert client.deleted_refs == []
    assert result.closed_prs == [18]


def test_cleanup_script_compensates_final_ref_lookup_timeout() -> None:
    """A final ref timeout should reopen before propagating."""
    pull = _workflow_pull(number=18, changed_files=0)

    class TimedOutFinalLookupClient(FakeCleanupClient):
        """Fake client whose final expected-SHA lookup times out."""

        head_ref_calls = 0

        def get_ref_sha(self, *, ref: str) -> str | None:
            """Time out on the second head lookup."""
            if ref == f"heads/{WORKFLOW_BRANCH}":
                self.head_ref_calls += 1
                if self.head_ref_calls > 1:
                    raise TimeoutError("final lookup timed out")
            return super().get_ref_sha(ref=ref)

    client = TimedOutFinalLookupClient(open_pulls=[pull], closed_pulls=[])

    result = _cleanup(client, close_obsolete_prs=True)

    assert client.reopened_prs == []
    assert client.deleted_refs == []
    assert result.closed_prs == [18]


def test_cleanup_script_compensates_delete_timeout() -> None:
    """A deletion timeout should reopen the just-closed pull and propagate."""
    pull = _workflow_pull(number=18, changed_files=0)

    class TimedOutDeleteClient(FakeCleanupClient):
        """Fake client whose branch deletion times out."""

        def delete_ref(self, ref: str, *, expected_sha: str) -> cleanup.DeleteRefOutcome:
            """Time out while deleting the expected workflow branch."""
            assert ref == f"heads/{WORKFLOW_BRANCH}"
            assert expected_sha == "sha"
            raise TimeoutError("delete timed out")

    client = TimedOutDeleteClient(open_pulls=[pull], closed_pulls=[])

    result = _cleanup(client, close_obsolete_prs=True)

    assert client.reopened_prs == []
    assert client.deleted_refs == []
    assert result.closed_prs == [18]


def test_cleanup_script_does_not_claim_rejected_lease_deletion() -> None:
    """A lease rejection should not be reported as a deleted branch."""
    pull = _workflow_pull(number=7, merged_at="2026-05-28T00:00:00Z")

    class RejectedLeaseClient(FakeCleanupClient):
        """Fake client whose atomic deletion lease is rejected."""

        def delete_ref(self, ref: str, *, expected_sha: str) -> cleanup.DeleteRefOutcome:
            """Report a rejected lease without recording deletion."""
            assert ref == f"heads/{WORKFLOW_BRANCH}"
            assert expected_sha == "sha"
            return cleanup.DeleteRefOutcome.LEASE_REJECTED

    client = RejectedLeaseClient(open_pulls=[], closed_pulls=[pull])

    result = _cleanup(client)

    assert client.deleted_refs == []
    assert result.deleted_branches == []


def test_reopen_and_protect_removes_compensated_pull_from_result() -> None:
    """Compensation should reopen an unchanged close and retract its result."""
    pull = {
        **_workflow_pull(number=18, changed_files=0),
        "state": "closed",
        "updated_at": "2026-07-27T12:00:00Z",
    }
    identity = cleanup._close_identity(pull)
    assert identity is not None
    client = FakeCleanupClient(open_pulls=[], closed_pulls=[pull])
    result = cleanup.CleanupResult(closed_prs=[18])
    protected_branches: set[str] = set()

    cleanup._reopen_and_protect(
        client=client,
        pulls=frozenset({identity}),
        branch_name=WORKFLOW_BRANCH,
        protected_branches=protected_branches,
        result=result,
    )

    assert client.reopened_prs == [18]
    assert result.closed_prs == []
    assert protected_branches == {WORKFLOW_BRANCH}


def test_cleanup_script_preserves_closed_branch_that_moves_before_delete() -> None:
    """Cleanup should preserve a closed PR branch that moves before deletion."""
    pull = _workflow_pull(number=7, merged_at="2026-05-28T00:00:00Z")

    class MovingHeadClient(FakeCleanupClient):
        """Fake client whose branch moves after candidate validation."""

        head_ref_calls = 0

        def get_ref_sha(self, *, ref: str) -> str | None:
            """Return a moved SHA at the final deletion check."""
            assert ref == f"heads/{WORKFLOW_BRANCH}"
            self.head_ref_calls += 1
            return "sha" if self.head_ref_calls == 1 else "new-sha"

    client = MovingHeadClient(open_pulls=[], closed_pulls=[pull])

    result = _cleanup(client)

    assert client.deleted_refs == []
    assert result.deleted_branches == []


def test_cleanup_script_propagates_reopen_failure_after_revision_moves() -> None:
    """Cleanup should expose a failed compensation instead of claiming success."""
    pull = _workflow_pull(number=18, changed_files=0)

    class FailedReopenClient(FakeCleanupClient):
        """Fake client whose head moves on close and cannot be reopened."""

        def close_pull(self, pull_number: int) -> dict[str, object]:
            """Record the close and move the base to require compensation."""
            response = super().close_pull(pull_number)
            self.ref_shas["heads/main"] = "new-base-sha"
            return response

        def reopen_pull(self, pull_number: int) -> None:
            """Raise the compensation failure."""
            raise RuntimeError(f"Could not reopen PR {pull_number}")

    client = FailedReopenClient(
        open_pulls=[pull],
        closed_pulls=[],
    )

    with pytest.raises(RuntimeError, match="Could not reopen PR 18"):
        _cleanup(
            client,
            keep_latest_open_pr=True,
            close_obsolete_prs=True,
        )

    assert client.closed_prs == [18]
    assert client.deleted_refs == []


def test_cleanup_script_closes_pull_when_rename_matches_current_base() -> None:
    """Push cleanup should compare both paths from an already-applied rename."""
    client = FakeCleanupClient(
        open_pulls=[_workflow_pull(number=18, changed_files=1)],
        closed_pulls=[],
        comparison_files={
            ("base-sha", "sha"): [
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
    assert client.deleted_refs == []
    assert result.closed_prs == [10, 9]
    assert result.deleted_branches == []


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
    assert client.deleted_refs == [f"heads/{WORKFLOW_BRANCH}-merged"]
    assert result.closed_prs == [17]
    assert result.deleted_branches == [f"{WORKFLOW_BRANCH}-merged"]


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


def test_cleanup_script_rechecks_ownership_before_closed_branch_deletion() -> None:
    """A removed ownership label should block a closed branch lease deletion."""
    pull = _workflow_pull(number=7)
    without_label = _workflow_pull(number=7, label="other")
    client = FakeCleanupClient(
        open_pulls=[],
        closed_pulls=[pull],
        pull_details={7: [without_label]},
    )

    result = _cleanup(
        client,
        delete_stale_branches=True,
        delete_merged_branches=False,
    )

    assert client.deleted_refs == []
    assert result.deleted_branches == []


@pytest.mark.parametrize("open_pull_number", [7, 8])
def test_cleanup_script_rechecks_any_open_pr_before_branch_deletion(
    open_pull_number: int,
) -> None:
    """A reopened or different open PR on the ref should block deletion."""
    closed_pull = _workflow_pull(number=7)
    newly_open_pull = _workflow_pull(number=open_pull_number)

    class OpenRaceClient(FakeCleanupClient):
        """Fake client that exposes an open PR only at final deletion."""

        open_list_calls = 0

        def list_pulls(self, *, state: str) -> list[dict[str, object]]:
            """Return the racing open PR after initial enumeration."""
            if state == "open":
                self.open_list_calls += 1
                return [] if self.open_list_calls == 1 else [newly_open_pull]
            return super().list_pulls(state=state)

    client = OpenRaceClient(open_pulls=[], closed_pulls=[closed_pull])

    result = _cleanup(
        client,
        delete_stale_branches=True,
        delete_merged_branches=False,
    )

    assert client.deleted_refs == []
    assert result.deleted_branches == []


def test_cleanup_script_protects_open_branch_when_stale_closing_is_disabled() -> None:
    """An open workflow branch should override a closed deletion candidate."""
    client = FakeCleanupClient(
        open_pulls=[_workflow_pull(number=18)],
        closed_pulls=[_workflow_pull(number=7)],
    )

    result = _cleanup(
        client,
        close_stale_prs=False,
        delete_stale_branches=True,
        delete_merged_branches=False,
    )

    assert client.closed_prs == []
    assert client.deleted_refs == []
    assert result.closed_prs == []
    assert result.deleted_branches == []


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


def test_cleanup_script_preserves_prs_that_fail_ownership_checks() -> None:
    """Cleanup script should not mutate PRs that fail workflow ownership checks."""
    client = FakeCleanupClient(
        open_pulls=[
            _workflow_pull(number=13, ref=f"{WORKFLOW_BRANCH}-manual-fix", author="maintainer"),
            _workflow_pull(
                number=15,
                ref=f"{WORKFLOW_BRANCH}-other-workflow",
                label="other-workflow",
            ),
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


def test_github_client_closes_reopens_and_gets_pull(
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

    assert client.close_pull(18) == pull
    client.reopen_pull(18)
    assert client.get_pull(18) == pull
    assert calls == [
        (
            "PATCH",
            "https://api.github.com/repos/o/r/pulls/18",
            {"state": "closed"},
        ),
        (
            "PATCH",
            "https://api.github.com/repos/o/r/pulls/18",
            {"state": "open"},
        ),
        ("GET", "https://api.github.com/repos/o/r/pulls/18", None),
    ]


def test_github_client_rejects_invalid_close_payload(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Close should reject a response that cannot provide pull metadata."""
    client = cleanup.GithubClient(repository=REPOSITORY, token="token")
    monkeypatch.setattr(client, "_request", lambda *_args, **_kwargs: ([], None))

    with pytest.raises(TypeError, match="Expected a pull request object"):
        client.close_pull(18)


def test_github_client_lists_pulls_across_pages(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """GitHub client should paginate pulls and ignore malformed list items."""
    calls: list[str] = []
    next_url = "https://api.github.com/repositories/1/pulls?state=open&page=2"

    def fake_request(method: str, url: str) -> tuple[object, str | None]:
        """Return two fake pages of pull requests."""
        assert method == "GET"
        calls.append(url)
        if len(calls) == 1:
            return [{"number": 1}, None], f'<{next_url}>; rel="next"'
        return [{"number": 2}], None

    client = cleanup.GithubClient(repository=REPOSITORY, token="token")
    monkeypatch.setattr(client, "_request", fake_request)

    assert client.list_pulls(state="open") == [{"number": 1}, {"number": 2}]
    assert calls == [
        "https://api.github.com/repos/o/r/pulls?state=open&per_page=100",
        next_url,
    ]


def test_github_client_rejects_invalid_pull_list(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """GitHub client should reject a non-list pull response."""
    client = cleanup.GithubClient(repository=REPOSITORY, token="token")
    monkeypatch.setattr(client, "_request", lambda *_args: ({}, None))

    with pytest.raises(TypeError, match="Expected pull request list"):
        client.list_pulls(state="open")


def test_github_client_gets_files_from_immutable_comparison(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """GitHub client should validate commit evidence from the compare endpoint."""
    calls: list[str] = []

    def fake_request(method: str, url: str) -> tuple[object, None]:
        """Return an immutable comparison payload."""
        assert method == "GET"
        calls.append(url)
        return {
            "base_commit": {"sha": "base#sha"},
            "commits": [{"sha": "head#sha"}],
            "files": [{"filename": "prek.toml"}],
        }, None

    client = cleanup.GithubClient(repository=REPOSITORY, token="token")
    monkeypatch.setattr(client, "_request", fake_request)

    assert client.compare_files(base_sha="base#sha", head_sha="head#sha") == [
        {"filename": "prek.toml"}
    ]
    assert calls == [
        "https://api.github.com/repos/o/r/compare/base%23sha...head%23sha",
    ]


@pytest.mark.parametrize(
    ("payload", "message"),
    [
        ([], "Expected comparison object"),
        ({}, "Expected comparison file list"),
        ({"files": [None]}, "Expected comparison file list"),
        (
            {"base_commit": {"sha": "wrong"}, "files": []},
            "Expected comparison base SHA",
        ),
        (
            {"commits": [{"sha": "wrong"}], "files": []},
            "Expected comparison head SHA",
        ),
    ],
)
def test_github_client_rejects_invalid_comparison(
    monkeypatch: pytest.MonkeyPatch,
    payload: object,
    message: str,
) -> None:
    """GitHub client should reject malformed or mismatched comparisons."""
    client = cleanup.GithubClient(repository=REPOSITORY, token="token")
    monkeypatch.setattr(client, "_request", lambda *_args: (payload, None))

    with pytest.raises(TypeError, match=message):
        client.compare_files(base_sha="base-sha", head_sha="head-sha")


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


@pytest.mark.parametrize("pull", [{"head": None}, {"head": {}}])
def test_head_ref_rejects_malformed_heads(pull: dict[str, object]) -> None:
    """Pull head extraction should reject malformed API objects."""
    with pytest.raises(TypeError, match="missing a head ref"):
        cleanup._head_ref(pull)


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
        {**_workflow_pull(number=18, changed_files=1), "head": None},
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


@pytest.mark.parametrize(
    ("pull", "ref_shas"),
    [
        (_workflow_pull(number=18, repository="fork/r"), {}),
        (_workflow_pull(number=18), {f"heads/{WORKFLOW_BRANCH}": None}),
    ],
)
def test_matching_branch_head_sha_requires_same_repo_existing_ref(
    pull: dict[str, object],
    ref_shas: dict[str, str | None],
) -> None:
    """Branch matching should reject fork heads and absent branch refs."""
    client = FakeCleanupClient(open_pulls=[], closed_pulls=[], ref_shas=ref_shas)

    assert (
        cleanup._matching_branch_head_sha(
            client=client,
            pull=pull,
            repository=REPOSITORY,
        )
        is None
    )


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
        comparison_files={("base-sha", "sha"): [{"filename": "prek.toml"}]},
        ref_shas={"heads/main": "base-sha"},
    )

    assert not cleanup._pull_is_obsolete(client, pull)


def test_obsolete_comparison_ignores_mutable_pull_file_aba_state() -> None:
    """Obsolete evidence should use only the captured base/head commit pair."""
    pull = _workflow_pull(number=18, changed_files=1)

    class ImmutableComparisonClient(FakeCleanupClient):
        """Fake client that rejects access to mutable PR file state."""

        comparisons: tuple[tuple[str, str], ...] = ()

        def compare_files(self, *, base_sha: str, head_sha: str) -> list[dict[str, object]]:
            """Record the immutable comparison requested by cleanup."""
            self.comparisons = (*self.comparisons, (base_sha, head_sha))
            return [{"filename": "prek.toml"}]

        def list_pull_files(self, _pull_number: int) -> list[dict[str, object]]:
            """Fail if obsolete detection regresses to mutable PR file state."""
            raise AssertionError("Mutable PR file state must not be read")

    client = ImmutableComparisonClient(
        open_pulls=[pull],
        closed_pulls=[],
        ref_shas={"heads/main": "base-sha"},
        tree_entries={
            "sha": {"prek.toml": ("100644", "blob", "shared")},
            "base-sha": {"prek.toml": ("100644", "blob", "shared")},
        },
    )

    assert cleanup._pull_is_obsolete(client, pull)
    assert client.comparisons == (("base-sha", "sha"),)


def test_pull_is_not_obsolete_when_head_changes_during_comparison() -> None:
    """Obsolete detection should preserve PRs whose head moves mid-check."""
    pull = _workflow_pull(number=18, changed_files=1)
    moved = _workflow_pull(number=18, head_sha="new-sha", changed_files=1)
    client = FakeCleanupClient(
        open_pulls=[pull],
        closed_pulls=[],
        comparison_files={("base-sha", "sha"): [{"filename": "prek.toml"}]},
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
        comparison_files={("base-sha", "sha"): [{"filename": "prek.toml"}]},
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
        comparison_files={("base-sha", "sha"): [{"filename": "prek.toml"}]},
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
        comparison_files={("base-sha", "sha"): [{"filename": "prek.toml"}]},
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


@pytest.mark.parametrize(
    "error",
    [
        subprocess.TimeoutExpired(["git", "push"], 30),
        subprocess.CalledProcessError(1, ["git", "push"]),
    ],
)
def test_main_returns_failure_for_subprocess_errors(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    error: subprocess.SubprocessError,
) -> None:
    """CLI should convert git timeout and command failures into exit code 1."""

    def fail_cleanup(**_kwargs: object) -> object:
        """Raise a subprocess operational error."""
        raise error

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


def test_github_client_deletes_ref_with_atomic_push_lease(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Lease deletion should target the consumer repo without relying on a checkout."""
    calls: list[tuple[list[str], dict[str, str]]] = []
    tooling_root = tmp_path / "tooling"
    subprocess.run(  # noqa: S603 - initializes the isolated test repository
        ["/usr/bin/git", "init", str(tooling_root)],
        check=True,
        capture_output=True,
        text=True,
    )
    monkeypatch.setattr(cleanup, "TOOLING_ROOT", tooling_root)

    def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        """Record the lease-guarded git invocation."""
        environment = kwargs["env"]
        assert isinstance(environment, dict)
        assert kwargs["timeout"] == cleanup.GIT_PUSH_TIMEOUT_SECONDS
        assert command[1:3] == ["-C", str(tooling_root)]
        assert (tooling_root / ".git").is_dir()
        calls.append((command, environment))
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr("prek_autoupdate.cleanup_prek_update_branches.subprocess.run", fake_run)
    client = cleanup.GithubClient(repository=REPOSITORY, token="secret-token")
    workflow_root = tmp_path / "workflow-root"
    workflow_root.mkdir()
    monkeypatch.chdir(workflow_root)

    assert (
        client.delete_ref("heads/feature#1", expected_sha="expected-sha")
        is cleanup.DeleteRefOutcome.DELETED
    )

    command, environment = calls[0]
    assert command == [
        "git",
        "-C",
        str(tooling_root),
        "push",
        "https://github.com/o/r.git",
        "--force-with-lease=refs/heads/feature#1:expected-sha",
        ":refs/heads/feature#1",
    ]
    assert "secret-token" not in " ".join(command)
    encoded_credential = base64.b64encode(b"x-access-token:secret-token").decode()
    assert encoded_credential not in " ".join(command)
    assert environment["GIT_CONFIG_KEY_0"] == "http.https://github.com/.extraheader"
    assert environment["GIT_TERMINAL_PROMPT"] == "0"
    header = environment["GIT_CONFIG_VALUE_0"]
    prefix = "AUTHORIZATION: basic "
    assert hmac.compare_digest(header[: len(prefix)], prefix)
    assert hmac.compare_digest(
        base64.b64decode(header.removeprefix(prefix)),
        b"x-access-token:secret-token",
    )


def test_github_client_reports_rejected_delete_lease(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A rejected lease should safely report that no deletion occurred."""
    monkeypatch.setattr(
        "prek_autoupdate.cleanup_prek_update_branches.subprocess.run",
        lambda *_args, **_kwargs: subprocess.CompletedProcess(["git", "push"], 1, "", "stale info"),
    )
    client = cleanup.GithubClient(repository=REPOSITORY, token="token")
    monkeypatch.setattr(client, "get_ref_sha", lambda **_kwargs: "moved-sha")

    assert (
        client.delete_ref("heads/feature", expected_sha="expected-sha")
        is cleanup.DeleteRefOutcome.LEASE_REJECTED
    )


def test_github_client_reports_absent_ref_after_failed_push(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A failed push followed by a missing ref should be idempotent success."""
    monkeypatch.setattr(
        "prek_autoupdate.cleanup_prek_update_branches.subprocess.run",
        lambda *_args, **_kwargs: subprocess.CompletedProcess(["git", "push"], 1, "", "failed"),
    )
    client = cleanup.GithubClient(repository=REPOSITORY, token="token")
    monkeypatch.setattr(client, "get_ref_sha", lambda **_kwargs: None)

    assert (
        client.delete_ref("heads/feature", expected_sha="expected-sha")
        is cleanup.DeleteRefOutcome.ALREADY_ABSENT
    )


def test_github_client_propagates_failed_push_when_ref_is_unchanged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A failed deletion should propagate while the expected ref remains."""
    monkeypatch.setattr(
        "prek_autoupdate.cleanup_prek_update_branches.subprocess.run",
        lambda *_args, **_kwargs: subprocess.CompletedProcess(
            ["git", "push"], 1, "output", "failed"
        ),
    )
    client = cleanup.GithubClient(repository=REPOSITORY, token="token")
    monkeypatch.setattr(client, "get_ref_sha", lambda **_kwargs: "expected-sha")

    with pytest.raises(subprocess.CalledProcessError) as exc_info:
        client.delete_ref("heads/feature", expected_sha="expected-sha")

    assert exc_info.value.output == "output"
    assert exc_info.value.stderr == "failed"


@pytest.mark.parametrize(
    ("current_sha", "outcome"),
    [
        (None, cleanup.DeleteRefOutcome.ALREADY_ABSENT),
        ("moved-sha", cleanup.DeleteRefOutcome.LEASE_REJECTED),
    ],
)
def test_github_client_resolves_ref_state_after_push_timeout(
    monkeypatch: pytest.MonkeyPatch,
    current_sha: str | None,
    outcome: cleanup.DeleteRefOutcome,
) -> None:
    """A timed-out deletion should report the ref's refreshed state."""

    def time_out(*_args: object, **_kwargs: object) -> None:
        """Raise a bounded git push timeout."""
        raise subprocess.TimeoutExpired(["git", "push"], 30)

    monkeypatch.setattr("prek_autoupdate.cleanup_prek_update_branches.subprocess.run", time_out)
    client = cleanup.GithubClient(repository=REPOSITORY, token="token")
    monkeypatch.setattr(client, "get_ref_sha", lambda **_kwargs: current_sha)

    assert client.delete_ref("heads/feature", expected_sha="expected-sha") is outcome


def test_github_client_propagates_push_timeout_when_ref_is_unchanged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An uncertain timeout should propagate while the expected ref remains."""

    def time_out(*_args: object, **_kwargs: object) -> None:
        """Raise a bounded git push timeout."""
        raise subprocess.TimeoutExpired(["git", "push"], 30)

    monkeypatch.setattr("prek_autoupdate.cleanup_prek_update_branches.subprocess.run", time_out)
    client = cleanup.GithubClient(repository=REPOSITORY, token="token")
    monkeypatch.setattr(client, "get_ref_sha", lambda **_kwargs: "expected-sha")

    with pytest.raises(subprocess.TimeoutExpired):
        client.delete_ref("heads/feature", expected_sha="expected-sha")

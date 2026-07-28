"""Clean up stale prek autoupdate pull requests and branches."""

from __future__ import annotations

import argparse
import base64
import json
import logging
import os
import subprocess
import sys
from dataclasses import dataclass, field
from enum import Enum, auto
from pathlib import Path
from typing import TYPE_CHECKING, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence

GITHUB_API_URL = "https://api.github.com"
HTTP_NO_CONTENT = 204
HTTP_NOT_FOUND = 404
GIT_PUSH_TIMEOUT_SECONDS = 30
TOOLING_ROOT = Path(__file__).resolve().parents[2]
LOGGER = logging.getLogger(__name__)


@dataclass
class CleanupResult:
    """Result of cleaning workflow-owned pull requests and branches.

    Attributes:
        closed_prs: Pull request numbers closed during cleanup.
        deleted_branches: Branch names deleted from the repository.

    """

    closed_prs: list[int] = field(default_factory=list)
    deleted_branches: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class PullComparisonSnapshot:
    """Pull request revisions used to decide that a pull is obsolete."""

    head_sha: str
    head_ref: str
    base_ref: str
    base_sha: str
    changed_files: int


@dataclass(frozen=True)
class CompensatablePull:
    """Exact closed pull revision that cleanup may immediately reopen."""

    number: int
    head_sha: str
    head_ref: str
    base_ref: str
    changed_files: int
    updated_at: str


@dataclass(frozen=True)
class BranchDeletion:
    """A branch deletion bound to an expected revision."""

    expected_sha: str
    pull_numbers: frozenset[int] = frozenset()


@dataclass(frozen=True)
class OwnershipPolicy:
    """Workflow ownership attributes required before mutation."""

    repository: str
    branch: str
    branch_prefix: str
    label_name: str
    author_login: str | None
    body_marker: str | None


class DeleteRefOutcome(Enum):
    """Outcome of an atomic ref deletion attempt."""

    DELETED = auto()
    ALREADY_ABSENT = auto()
    LEASE_REJECTED = auto()


class CleanupClient(Protocol):
    """GitHub operations needed by the cleanup routine."""

    def list_pulls(self, *, state: str) -> list[dict[str, object]]:
        """List pull requests by state."""

    def get_pull(self, pull_number: int) -> dict[str, object]:
        """Get a pull request by number."""

    def compare_files(self, *, base_sha: str, head_sha: str) -> list[dict[str, object]]:
        """List files from an immutable commit comparison."""

    def get_tree_entries(
        self, *, paths: set[str], ref: str
    ) -> dict[str, tuple[str, str, str] | None] | None:
        """Return Git tree entry identities for paths at a git ref."""

    def close_pull(self, pull_number: int) -> dict[str, object]:
        """Close a pull request and return the resulting payload."""

    def reopen_pull(self, pull_number: int) -> None:
        """Reopen a pull request by number."""

    def delete_ref(self, ref: str, *, expected_sha: str) -> DeleteRefOutcome:
        """Delete a git ref only when it still has the expected SHA."""

    def get_ref_sha(self, *, ref: str) -> str | None:
        """Return the current SHA for a git ref."""


class GithubClient:
    """Small GitHub REST client for the workflow cleanup task."""

    def __init__(self, *, repository: str, token: str) -> None:
        """Initialize the client.

        Args:
            repository: Repository in ``owner/name`` format.
            token: GitHub token for API calls.

        """
        self.repository = repository
        self.token = token

    def list_pulls(self, *, state: str) -> list[dict[str, object]]:
        """List pull requests by state.

        Args:
            state: Pull request state to request.

        Returns:
            Pull request objects from GitHub.

        """
        pulls: list[dict[str, object]] = []
        url: str | None = (
            f"{GITHUB_API_URL}/repos/{self.repository}/pulls?state={state}&per_page=100"
        )
        while url is not None:
            payload, link_header = self._request("GET", url)
            if not isinstance(payload, list):
                raise TypeError(f"Expected pull request list from {url}")
            pulls.extend(pull for pull in payload if isinstance(pull, dict))
            url = _next_link(link_header)
        return pulls

    def close_pull(self, pull_number: int) -> dict[str, object]:
        """Close a pull request.

        Args:
            pull_number: Pull request number to close.

        """
        url = f"{GITHUB_API_URL}/repos/{self.repository}/pulls/{pull_number}"
        payload, _ = self._request("PATCH", url, payload={"state": "closed"})
        if not isinstance(payload, dict):
            raise TypeError(f"Expected a pull request object from {url}")
        return payload

    def reopen_pull(self, pull_number: int) -> None:
        """Reopen a pull request.

        Args:
            pull_number: Pull request number to reopen.

        """
        url = f"{GITHUB_API_URL}/repos/{self.repository}/pulls/{pull_number}"
        self._request("PATCH", url, payload={"state": "open"})

    def get_pull(self, pull_number: int) -> dict[str, object]:
        """Get a pull request.

        Args:
            pull_number: Pull request number to retrieve.

        Returns:
            Pull request object from GitHub.

        """
        url = f"{GITHUB_API_URL}/repos/{self.repository}/pulls/{pull_number}"
        payload, _ = self._request("GET", url)
        if not isinstance(payload, dict):
            raise TypeError(f"Expected a pull request object from {url}")
        return payload

    def compare_files(self, *, base_sha: str, head_sha: str) -> list[dict[str, object]]:
        """List files from an immutable commit comparison.

        Args:
            base_sha: Captured base commit SHA.
            head_sha: Captured head commit SHA.

        Returns:
            Changed file objects from GitHub.

        """
        safe_base = quote(base_sha, safe="")
        safe_head = quote(head_sha, safe="")
        url = f"{GITHUB_API_URL}/repos/{self.repository}/compare/{safe_base}...{safe_head}"
        payload, _ = self._request("GET", url)
        if not isinstance(payload, dict):
            raise TypeError(f"Expected comparison object from {url}")
        base_commit = payload.get("base_commit")
        if base_commit is not None and (
            not isinstance(base_commit, dict) or base_commit.get("sha") != base_sha
        ):
            raise TypeError(f"Expected comparison base SHA from {url}")
        commits = payload.get("commits")
        if commits is not None and (
            not isinstance(commits, list)
            or not commits
            or not isinstance(commits[-1], dict)
            or commits[-1].get("sha") != head_sha
        ):
            raise TypeError(f"Expected comparison head SHA from {url}")
        files = payload.get("files")
        if not isinstance(files, list) or not all(isinstance(file, dict) for file in files):
            raise TypeError(f"Expected comparison file list from {url}")
        return files

    def get_tree_entries(
        self, *, paths: set[str], ref: str
    ) -> dict[str, tuple[str, str, str] | None] | None:
        """Return Git tree entry identities for paths at a git ref.

        Args:
            paths: Repository-relative paths to retrieve.
            ref: Commit SHA.

        Returns:
            Path-to-entry mapping, with None for absent paths, or None when the
            recursive tree is truncated.

        """
        safe_ref = quote(ref, safe="")
        url = f"{GITHUB_API_URL}/repos/{self.repository}/git/trees/{safe_ref}?recursive=1"
        payload, _ = self._request("GET", url)
        if not isinstance(payload, dict):
            raise TypeError(f"Expected a Git tree object from {url}")
        if payload.get("truncated") is True:
            return None
        tree = payload.get("tree")
        if not isinstance(tree, list):
            raise TypeError(f"Expected a Git tree list from {url}")
        entries: dict[str, tuple[str, str, str] | None] = dict.fromkeys(paths)
        for item in tree:
            if not isinstance(item, dict):
                raise TypeError(f"Expected a Git tree entry from {url}")
            path = item.get("path")
            if path not in paths:
                continue
            mode = item.get("mode")
            entry_type = item.get("type")
            sha = item.get("sha")
            if (
                not isinstance(mode, str)
                or not isinstance(entry_type, str)
                or not isinstance(sha, str)
            ):
                raise TypeError(f"Expected a complete Git tree entry from {url}")
            entries[path] = (mode, entry_type, sha)
        return entries

    def delete_ref(self, ref: str, *, expected_sha: str) -> DeleteRefOutcome:
        """Atomically delete a git ref when it still has the expected SHA.

        Args:
            ref: Ref path such as ``heads/branch-name``.
            expected_sha: SHA required by the force-with-lease deletion.

        Returns:
            Explicit deletion, already-absent, or rejected-lease outcome.

        """
        full_ref = f"refs/{ref}"
        basic_credential = base64.b64encode(f"x-access-token:{self.token}".encode()).decode()
        environment = os.environ.copy()
        environment.update(
            {
                "GIT_CONFIG_COUNT": "1",
                "GIT_CONFIG_KEY_0": "http.https://github.com/.extraheader",
                "GIT_CONFIG_VALUE_0": f"AUTHORIZATION: basic {basic_credential}",
                "GIT_TERMINAL_PROMPT": "0",
            }
        )
        remote_url = f"https://github.com/{self.repository}.git"
        command = [
            "git",
            "-C",
            str(TOOLING_ROOT),
            "push",
            remote_url,
            f"--force-with-lease={full_ref}:{expected_sha}",
            f":{full_ref}",
        ]
        try:
            completed = subprocess.run(  # noqa: S603 - fixed git with validated repo/ref
                command,
                check=False,
                capture_output=True,
                env=environment,
                text=True,
                timeout=GIT_PUSH_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired:
            current_sha = self.get_ref_sha(ref=ref)
            if current_sha is None:
                return DeleteRefOutcome.ALREADY_ABSENT
            if current_sha != expected_sha:
                return DeleteRefOutcome.LEASE_REJECTED
            raise
        if completed.returncode == 0:
            return DeleteRefOutcome.DELETED
        current_sha = self.get_ref_sha(ref=ref)
        if current_sha is None:
            return DeleteRefOutcome.ALREADY_ABSENT
        if current_sha != expected_sha:
            return DeleteRefOutcome.LEASE_REJECTED
        raise subprocess.CalledProcessError(
            completed.returncode,
            command,
            output=completed.stdout,
            stderr=completed.stderr,
        )

    def get_ref_sha(self, *, ref: str) -> str | None:
        """Return the SHA for a git ref, or None when missing."""
        safe_ref = quote(ref, safe="/")
        url = f"{GITHUB_API_URL}/repos/{self.repository}/git/ref/{safe_ref}"
        try:
            payload, _ = self._request("GET", url)
        except HTTPError as err:
            if err.code == HTTP_NOT_FOUND:
                return None
            raise
        if not isinstance(payload, dict):
            raise TypeError(f"Expected a ref object from {url}")
        obj = payload.get("object")
        if not isinstance(obj, dict):
            raise TypeError(f"Expected ref object payload from {url}")
        sha = obj.get("sha")
        if not isinstance(sha, str):
            raise TypeError(f"Expected ref object SHA from {url}")
        return sha

    def _request(
        self,
        method: str,
        url: str,
        *,
        payload: Mapping[str, object] | None = None,
    ) -> tuple[object, str | None]:
        """Send a GitHub REST request.

        Args:
            method: HTTP method.
            url: Request URL.
            payload: Optional JSON payload.

        Returns:
            Decoded payload and Link header.

        """
        data = json.dumps(payload).encode() if payload is not None else None
        request = Request(url, data=data, headers=_github_headers(self.token), method=method)
        with urlopen(request, timeout=30) as response:
            if response.status == HTTP_NO_CONTENT:
                return {}, response.headers.get("Link")
            return json.load(response), response.headers.get("Link")


def cleanup_update_branches(
    *,
    client: CleanupClient,
    repository: str,
    branch: str,
    branch_prefix: str,
    label_name: str,
    author_login: str | None,
    body_marker: str | None,
    keep_pr_number: int | None,
    close_stale_prs: bool,
    delete_merged_branches: bool,
    delete_stale_branches: bool = False,
    keep_latest_open_pr: bool = False,
    close_obsolete_prs: bool = False,
) -> CleanupResult:
    """Clean workflow-owned stale or obsolete pull requests and branches.

    Args:
        client: GitHub client with list, close, and delete methods.
        repository: Repository in ``owner/name`` format.
        branch: Current workflow update branch.
        branch_prefix: Prefix for workflow-owned update branches.
        label_name: Label identifying workflow-created PRs.
        author_login: Optional author login identifying workflow-created PRs.
        body_marker: Optional body text identifying workflow-created PRs.
        keep_pr_number: Optional PR number to preserve.
        close_stale_prs: Whether to close open stale update PRs.
        delete_stale_branches: Whether to delete stale workflow-owned branch refs.
        delete_merged_branches: Whether to delete branches from merged update PRs.
        keep_latest_open_pr: Whether to preserve the newest open workflow PR.
        close_obsolete_prs: Whether to close workflow PRs with no changes unique to the
            current base.

    Returns:
        Summary of cleanup actions.

    """
    result = CleanupResult()
    policy = OwnershipPolicy(
        repository, branch, branch_prefix, label_name, author_login, body_marker
    )
    open_pulls = client.list_pulls(state="open")
    workflow_open_pulls = _workflow_pulls(
        open_pulls,
        repository=repository,
        branch=branch,
        branch_prefix=branch_prefix,
        label_name=label_name,
        author_login=author_login,
        body_marker=body_marker,
    )
    workflow_open_pull_numbers = {_pull_number(pull) for pull in workflow_open_pulls}
    protected_branches = _collect_protected_branches(
        all_pulls=open_pulls,
        workflow_open_pull_numbers=workflow_open_pull_numbers,
        repository=repository,
        branch_prefix=branch_prefix,
    )
    branches_to_delete: dict[str, BranchDeletion] = {}

    latest_open_pr_number = (
        max(workflow_open_pull_numbers, default=None) if keep_latest_open_pr else None
    )
    for pull in workflow_open_pulls:
        pull_number = _pull_number(pull)

        if _close_obsolete_pull(
            client=client,
            pull=pull,
            policy=policy,
            enabled=close_obsolete_prs,
            result=result,
            protected_branches=protected_branches,
        ):
            continue

        _handle_stale_open_pull(
            client=client,
            pull=pull,
            keep=pull_number in {keep_pr_number, latest_open_pr_number},
            close_stale_prs=close_stale_prs,
            policy=policy,
            result=result,
            protected_branches=protected_branches,
        )

    if delete_stale_branches or delete_merged_branches:
        for pull in _workflow_pulls(
            client.list_pulls(state="closed"),
            repository=repository,
            branch=branch,
            branch_prefix=branch_prefix,
            label_name=label_name,
            author_login=author_login,
            body_marker=body_marker,
        ):
            is_stale = pull.get("merged_at") is None
            should_delete = delete_stale_branches if is_stale else delete_merged_branches
            if (
                should_delete
                and (
                    head_sha := _matching_branch_head_sha(
                        client=client, pull=pull, repository=repository
                    )
                )
                is not None
            ):
                _queue_branch_deletion(
                    branches_to_delete=branches_to_delete,
                    protected_branches=protected_branches,
                    branch_name=_head_ref(pull),
                    deletion=BranchDeletion(head_sha, frozenset({_pull_number(pull)})),
                )

    _delete_queued_branches(
        client=client,
        branches_to_delete=branches_to_delete,
        protected_branches=protected_branches,
        result=result,
        policy=policy,
    )

    return result


def _handle_stale_open_pull(
    *,
    client: CleanupClient,
    pull: Mapping[str, object],
    keep: bool,
    close_stale_prs: bool,
    policy: OwnershipPolicy,
    result: CleanupResult,
    protected_branches: set[str],
) -> None:
    """Preserve or close a stale open workflow pull after ownership refresh."""
    pull_number = _pull_number(pull)
    head_ref = _head_ref(pull)
    if keep or not close_stale_prs:
        protected_branches.add(head_ref)
        return
    if not _pull_owned_by_policy(client.get_pull(pull_number), policy=policy):
        protected_branches.add(head_ref)
        return
    closed_pull = client.close_pull(pull_number)
    close_identity = _close_identity(closed_pull)
    if close_identity is None:
        protected_branches.add(head_ref)
        return
    if not _pull_owned_by_policy(closed_pull, policy=policy):
        _reopen_and_protect(
            client=client,
            pulls=frozenset({close_identity}),
            branch_name=head_ref,
            protected_branches=protected_branches,
            result=result,
        )
        return
    result.closed_prs.append(pull_number)
    protected_branches.add(head_ref)


def _queue_branch_deletion(
    *,
    branches_to_delete: dict[str, BranchDeletion],
    protected_branches: set[str],
    branch_name: str,
    deletion: BranchDeletion,
) -> None:
    """Queue compatible closed-PR evidence or protect on conflict."""
    existing = branches_to_delete.get(branch_name)
    if existing is None:
        branches_to_delete[branch_name] = deletion
        return
    pull_numbers = existing.pull_numbers | deletion.pull_numbers
    if existing.expected_sha == deletion.expected_sha:
        branches_to_delete[branch_name] = BranchDeletion(existing.expected_sha, pull_numbers)
        return
    protected_branches.add(branch_name)
    branches_to_delete.pop(branch_name)


def _reopen_and_protect(
    *,
    client: CleanupClient,
    pulls: frozenset[CompensatablePull],
    branch_name: str,
    protected_branches: set[str],
    result: CleanupResult,
) -> None:
    """Reopen only pulls still matching cleanup's exact close identity."""
    for identity in sorted(pulls, key=lambda pull: pull.number):
        if identity.number in result.closed_prs:
            result.closed_prs.remove(identity.number)
        try:
            current = client.get_pull(identity.number)
        except (HTTPError, URLError, TimeoutError, TypeError) as err:
            LOGGER.warning(
                "Could not validate compensated PR #%s after a concurrent transition: %s",
                identity.number,
                err,
            )
            continue
        if not _pull_matches_close_identity(current, identity):
            LOGGER.warning(
                "PR #%s changed after cleanup closed it; preserving branch %s without reopening.",
                identity.number,
                branch_name,
            )
            continue
        client.reopen_pull(identity.number)
    protected_branches.add(branch_name)


def _delete_queued_branches(
    *,
    client: CleanupClient,
    branches_to_delete: dict[str, BranchDeletion],
    protected_branches: set[str],
    result: CleanupResult,
    policy: OwnershipPolicy,
) -> None:
    """Delete only branches that still match their validated revision."""
    for branch_name in sorted(branches_to_delete):
        if branch_name in protected_branches:
            continue
        deletion = branches_to_delete[branch_name]
        if not all(
            _closed_pull_still_owned(
                client.get_pull(pull_number),
                pull_number=pull_number,
                branch_name=branch_name,
                expected_sha=deletion.expected_sha,
                policy=policy,
            )
            for pull_number in deletion.pull_numbers
        ):
            protected_branches.add(branch_name)
            continue
        current_sha = client.get_ref_sha(ref=f"heads/{branch_name}")
        if current_sha != deletion.expected_sha:
            continue
        if any(
            _same_repo_head_ref(pull, repository=policy.repository) == branch_name
            for pull in client.list_pulls(state="open")
        ):
            protected_branches.add(branch_name)
            continue
        outcome = client.delete_ref(f"heads/{branch_name}", expected_sha=deletion.expected_sha)
        if outcome is DeleteRefOutcome.DELETED:
            result.deleted_branches.append(branch_name)
        elif outcome is DeleteRefOutcome.LEASE_REJECTED:
            protected_branches.add(branch_name)


def _close_obsolete_pull(
    *,
    client: CleanupClient,
    pull: Mapping[str, object],
    policy: OwnershipPolicy,
    enabled: bool,
    result: CleanupResult,
    protected_branches: set[str],
) -> bool:
    """Close an obsolete pull and protect its branch until a later cleanup."""
    snapshot = _obsolete_pull_snapshot(client, pull) if enabled else None
    if snapshot is None:
        return False

    pull_number = _pull_number(pull)
    refreshed_before_close = client.get_pull(pull_number)
    if not _pull_owned_by_policy(refreshed_before_close, policy=policy):
        protected_branches.add(snapshot.head_ref)
        return True
    try:
        closed_pull = client.close_pull(pull_number)
        close_identity = _close_identity(closed_pull)
    except HTTPError, URLError, TimeoutError, TypeError:
        protected_branches.add(snapshot.head_ref)
        raise
    if close_identity is None:
        protected_branches.add(snapshot.head_ref)
        LOGGER.warning(
            "PR #%s close response lacked a safe mutation identity; preserving its branch.",
            pull_number,
        )
        return True
    if not _pull_owned_by_policy(closed_pull, policy=policy):
        _reopen_and_protect(
            client=client,
            pulls=frozenset({close_identity}),
            branch_name=snapshot.head_ref,
            protected_branches=protected_branches,
            result=result,
        )
        return True
    try:
        snapshot_matches = _pull_matches_snapshot(
            client, pull_number, snapshot, required_state="closed"
        )
        branch_matches = (
            _same_repo_head_ref(pull, repository=policy.repository) == snapshot.head_ref
            and client.get_ref_sha(ref=f"heads/{snapshot.head_ref}") == snapshot.head_sha
        )
    except HTTPError, URLError, TimeoutError, TypeError:
        _reopen_and_protect(
            client=client,
            pulls=frozenset({close_identity}),
            branch_name=snapshot.head_ref,
            protected_branches=protected_branches,
            result=result,
        )
        raise
    if not snapshot_matches or not branch_matches:
        _reopen_and_protect(
            client=client,
            pulls=frozenset({close_identity}),
            branch_name=snapshot.head_ref,
            protected_branches=protected_branches,
            result=result,
        )
        return True

    result.closed_prs.append(pull_number)
    protected_branches.add(snapshot.head_ref)
    return True


def _pull_is_obsolete(client: CleanupClient, pull: Mapping[str, object]) -> bool:
    """Return whether a pull request has no changes unique to its current base."""
    return _obsolete_pull_snapshot(client, pull) is not None


def _close_identity(pull: Mapping[str, object]) -> CompensatablePull | None:
    """Return a safe compensation identity from a close mutation response."""
    number = pull.get("number")
    changed_files = pull.get("changed_files")
    updated_at = pull.get("updated_at")
    head_sha = _pull_head_sha(pull)
    head_ref = _pull_head_ref(pull)
    base_ref = _pull_base_ref(pull)
    if (
        type(number) is not int
        or pull.get("state") != "closed"
        or pull.get("merged_at") is not None
        or type(changed_files) is not int
        or changed_files < 0
        or not isinstance(updated_at, str)
        or head_sha is None
        or head_ref is None
        or base_ref is None
    ):
        return None
    return CompensatablePull(number, head_sha, head_ref, base_ref, changed_files, updated_at)


def _pull_matches_close_identity(pull: Mapping[str, object], identity: CompensatablePull) -> bool:
    """Return whether a pull remains the exact unmerged close mutation."""
    return _close_identity(pull) == identity


def _obsolete_pull_snapshot(
    client: CleanupClient, pull: Mapping[str, object]
) -> PullComparisonSnapshot | None:
    """Return the stable revisions proving a pull has no changes unique to its base."""
    pull_number = _pull_number(pull)
    details = client.get_pull(pull_number)
    changed_files = _pull_changed_files(details)
    head_sha = _pull_head_sha(details)
    head_ref = _pull_head_ref(details)
    base_ref = _pull_base_ref(details)
    if head_sha is None or head_ref is None or base_ref is None:
        return None
    base_sha = client.get_ref_sha(ref=f"heads/{base_ref}")
    if base_sha is None:
        return None
    snapshot = PullComparisonSnapshot(head_sha, head_ref, base_ref, base_sha, changed_files)
    if changed_files == 0:
        return snapshot if _pull_matches_snapshot(client, pull_number, snapshot) else None

    files = client.compare_files(base_sha=base_sha, head_sha=head_sha)
    if len(files) != changed_files:
        return None
    paths = _pull_file_paths(files)
    head_entries = client.get_tree_entries(paths=paths, ref=head_sha)
    base_entries = client.get_tree_entries(paths=paths, ref=base_sha)
    if not paths or head_entries is None or base_entries is None:
        return None

    return (
        snapshot
        if head_entries == base_entries and _pull_matches_snapshot(client, pull_number, snapshot)
        else None
    )


def _pull_matches_snapshot(
    client: CleanupClient,
    pull_number: int,
    snapshot: PullComparisonSnapshot,
    *,
    required_state: str | None = None,
) -> bool:
    """Return whether pull and base revisions still match a comparison snapshot."""
    refreshed = client.get_pull(pull_number)
    return (
        (required_state is None or refreshed.get("state") == required_state)
        and _pull_head_sha(refreshed) == snapshot.head_sha
        and _pull_head_ref(refreshed) == snapshot.head_ref
        and _pull_base_ref(refreshed) == snapshot.base_ref
        and _pull_changed_files(refreshed) == snapshot.changed_files
        and client.get_ref_sha(ref=f"heads/{snapshot.base_ref}") == snapshot.base_sha
    )


def _pull_file_paths(files: Sequence[Mapping[str, object]]) -> set[str]:
    """Return current and previous paths affected by pull request files."""
    paths: set[str] = set()
    for file in files:
        filename = file.get("filename")
        if not isinstance(filename, str):
            raise TypeError("Pull request file is missing a filename")
        paths.add(filename)
        previous_filename = file.get("previous_filename")
        if previous_filename is not None:
            if not isinstance(previous_filename, str):
                raise TypeError("Pull request file has an invalid previous filename")
            paths.add(previous_filename)
    return paths


def _collect_protected_branches(
    *,
    all_pulls: list[dict[str, object]],
    workflow_open_pull_numbers: set[int],
    repository: str,
    branch_prefix: str,
) -> set[str]:
    """Collect same-repo open refs that are not workflow-owned."""
    return {
        head_ref
        for pull in all_pulls
        if _pull_number(pull) not in workflow_open_pull_numbers
        and (head_ref := _same_repo_head_ref(pull, repository=repository)) is not None
        and head_ref.startswith(branch_prefix)
    }


def _workflow_pulls(
    pulls: list[dict[str, object]],
    *,
    repository: str,
    branch: str,
    branch_prefix: str,
    label_name: str,
    author_login: str | None,
    body_marker: str | None,
) -> list[dict[str, object]]:
    """Filter workflow-owned pull requests."""
    return [
        pull
        for pull in pulls
        if _is_workflow_pull(
            pull,
            repository=repository,
            branch=branch,
            branch_prefix=branch_prefix,
            label_name=label_name,
            author_login=author_login,
            body_marker=body_marker,
        )
    ]


def _same_repo_head_ref(pull: Mapping[str, object], *, repository: str) -> str | None:
    """Return the head ref when a pull request head belongs to this repository.

    Args:
        pull: Pull request object.
        repository: Repository in ``owner/name`` format.

    Returns:
        Same-repository head ref, or None for malformed or forked PR heads.

    """
    head = pull.get("head", {})
    if not isinstance(head, dict):
        return None
    head_ref = head.get("ref")
    if not isinstance(head_ref, str):
        return None
    head_repo = head.get("repo", {})
    if not isinstance(head_repo, dict) or head_repo.get("full_name") != repository:
        return None
    return head_ref


def _is_workflow_pull(
    pull: Mapping[str, object],
    *,
    repository: str,
    branch: str,
    branch_prefix: str,
    label_name: str,
    author_login: str | None,
    body_marker: str | None,
) -> bool:
    """Return whether a pull request belongs to this workflow.

    Args:
        pull: Pull request object.
        repository: Repository in ``owner/name`` format.
        branch: Current workflow update branch.
        branch_prefix: Prefix for workflow-owned update branches.
        label_name: Label identifying workflow-created PRs.
        author_login: Optional author login identifying workflow-created PRs.
        body_marker: Optional body text identifying workflow-created PRs.

    Returns:
        True when the PR head branch is owned by this workflow.

    """
    labels = pull.get("labels", [])
    if not isinstance(labels, list) or not any(
        isinstance(label, dict) and label.get("name") == label_name for label in labels
    ):
        return False

    if author_login is not None:
        user = pull.get("user", {})
        if not isinstance(user, dict) or user.get("login") != author_login:
            return False

    if body_marker is not None:
        body = pull.get("body")
        if not isinstance(body, str) or body_marker not in body:
            return False

    head_ref = _same_repo_head_ref(pull, repository=repository)
    return head_ref is not None and (head_ref == branch or head_ref.startswith(branch_prefix))


def _pull_owned_by_policy(pull: Mapping[str, object], *, policy: OwnershipPolicy) -> bool:
    """Return whether refreshed pull data still satisfies workflow ownership."""
    return _is_workflow_pull(
        pull,
        repository=policy.repository,
        branch=policy.branch,
        branch_prefix=policy.branch_prefix,
        label_name=policy.label_name,
        author_login=policy.author_login,
        body_marker=policy.body_marker,
    )


def _closed_pull_still_owned(
    pull: Mapping[str, object],
    *,
    pull_number: int,
    branch_name: str,
    expected_sha: str,
    policy: OwnershipPolicy,
) -> bool:
    """Return whether a closed deletion candidate remains owned and unchanged."""
    return (
        pull.get("state") == "closed"
        and _pull_number(pull) == pull_number
        and _pull_head_ref(pull) == branch_name
        and _pull_head_sha(pull) == expected_sha
        and _pull_owned_by_policy(pull, policy=policy)
    )


def _head_ref(pull: Mapping[str, object]) -> str:
    """Return a pull request head ref.

    Args:
        pull: Pull request object.

    Returns:
        Pull request head ref.

    """
    head = pull["head"]
    if not isinstance(head, dict):
        raise TypeError("Pull request is missing a head ref")
    head_ref = head.get("ref")
    if not isinstance(head_ref, str):
        raise TypeError("Pull request is missing a head ref")
    return head_ref


def _pull_head_sha(pull: Mapping[str, object]) -> str | None:
    """Return the pull request head SHA."""
    head = pull.get("head")
    if not isinstance(head, dict):
        return None
    sha = head.get("sha")
    return sha if isinstance(sha, str) else None


def _pull_head_ref(pull: Mapping[str, object]) -> str | None:
    """Return the pull request head ref when present."""
    head = pull.get("head")
    if not isinstance(head, dict):
        return None
    ref = head.get("ref")
    return ref if isinstance(ref, str) else None


def _pull_base_ref(pull: Mapping[str, object]) -> str | None:
    """Return the pull request base branch ref."""
    base = pull.get("base")
    if not isinstance(base, dict):
        return None
    ref = base.get("ref")
    return ref if isinstance(ref, str) else None


def _matching_branch_head_sha(
    *,
    client: CleanupClient,
    pull: Mapping[str, object],
    repository: str,
) -> str | None:
    """Return the PR head SHA when the same-repo branch still points to it."""
    head_ref = _same_repo_head_ref(pull, repository=repository)
    if head_ref is None:
        return None
    branch_sha = client.get_ref_sha(ref=f"heads/{head_ref}")
    if branch_sha is None:
        return None
    pull_head_sha = _pull_head_sha(pull)
    return pull_head_sha if branch_sha == pull_head_sha else None


def _pull_number(pull: Mapping[str, object]) -> int:
    """Return a pull request number.

    Args:
        pull: Pull request object.

    Returns:
        Pull request number.

    """
    number = pull["number"]
    if isinstance(number, int):
        return number
    if isinstance(number, str):
        return int(number)
    raise TypeError("Pull request is missing a numeric number")


def _pull_changed_files(pull: Mapping[str, object]) -> int:
    """Return the pull request's changed file count."""
    changed_files = pull.get("changed_files")
    if type(changed_files) is not int or changed_files < 0:
        raise TypeError("Pull request is missing a valid changed file count")
    return changed_files


def _github_headers(token: str) -> dict[str, str]:
    """Build GitHub API request headers.

    Args:
        token: GitHub token.

    Returns:
        Request headers.

    """
    return {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "prek-autoupdate-cleanup",
    }


def _next_link(link_header: str | None) -> str | None:
    """Return the next pagination URL from a GitHub Link header.

    Args:
        link_header: Raw Link header value.

    Returns:
        Next URL when present.

    """
    if not link_header:
        return None
    for link in link_header.split(","):
        url_part, *params = link.split(";")
        if any(param.strip() == 'rel="next"' for param in params):
            return url_part.strip()[1:-1]
    return None


def _parse_args(argv: Sequence[str]) -> argparse.Namespace:
    """Parse command-line arguments.

    Args:
        argv: Command-line arguments excluding the executable name.

    Returns:
        Parsed arguments.

    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--branch", required=True)
    parser.add_argument("--branch-prefix", required=True)
    parser.add_argument("--label-name", required=True)
    parser.add_argument("--author-login")
    parser.add_argument("--body-marker")
    parser.add_argument("--keep-pr-number", type=int)
    parser.add_argument("--keep-latest-open-pr", action="store_true")
    parser.add_argument("--close-stale-prs", action="store_true")
    parser.add_argument("--close-obsolete-prs", action="store_true")
    parser.add_argument("--delete-stale-branches", action="store_true")
    parser.add_argument("--delete-merged-branches", action="store_true")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    """Run workflow branch cleanup.

    Args:
        argv: Optional command-line arguments excluding the executable name.

    Returns:
        Process exit code.

    """
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        LOGGER.error("GITHUB_TOKEN is required for cleanup.")
        return 1

    client = GithubClient(repository=args.repository, token=token)
    try:
        result = cleanup_update_branches(
            client=client,
            repository=args.repository,
            branch=args.branch,
            branch_prefix=args.branch_prefix,
            label_name=args.label_name,
            author_login=args.author_login,
            body_marker=args.body_marker,
            keep_pr_number=args.keep_pr_number,
            keep_latest_open_pr=args.keep_latest_open_pr,
            close_stale_prs=args.close_stale_prs,
            close_obsolete_prs=args.close_obsolete_prs,
            delete_stale_branches=args.delete_stale_branches,
            delete_merged_branches=args.delete_merged_branches,
        )
    except (HTTPError, URLError, TimeoutError, subprocess.SubprocessError) as err:
        LOGGER.error(
            "Failed to clean prek update branches for %s branch %s: %s",
            args.repository,
            args.branch,
            err,
        )
        return 1
    LOGGER.info("Closed PRs: %s", result.closed_prs or "none")
    LOGGER.info("Deleted branches: %s", result.deleted_branches or "none")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Clean up stale prek autoupdate pull requests and branches."""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence

GITHUB_API_URL = "https://api.github.com"
HTTP_NO_CONTENT = 204
HTTP_NOT_FOUND = 404
HTTP_UNPROCESSABLE_CONTENT = 422
LOGGER = logging.getLogger(__name__)


@dataclass
class CleanupResult:
    """Result of cleaning workflow-owned pull requests and branches.

    Attributes:
        closed_prs: Pull request numbers closed as stale.
        deleted_branches: Branch names deleted from the repository.

    """

    closed_prs: list[int] = field(default_factory=list)
    deleted_branches: list[str] = field(default_factory=list)


class CleanupClient(Protocol):
    """GitHub operations needed by the cleanup routine."""

    def list_pulls(self, *, state: str) -> list[dict[str, object]]:
        """List pull requests by state."""

    def close_pull(self, pull_number: int) -> None:
        """Close a pull request by number."""

    def delete_ref(self, ref: str) -> None:
        """Delete a git ref by name."""

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

    def close_pull(self, pull_number: int) -> None:
        """Close a pull request.

        Args:
            pull_number: Pull request number to close.

        """
        url = f"{GITHUB_API_URL}/repos/{self.repository}/pulls/{pull_number}"
        self._request("PATCH", url, payload={"state": "closed"})

    def delete_ref(self, ref: str) -> None:
        """Delete a git ref if it exists.

        Args:
            ref: Ref path such as ``heads/branch-name``.

        """
        safe_ref = quote(ref, safe="/")
        url = f"{GITHUB_API_URL}/repos/{self.repository}/git/refs/{safe_ref}"
        try:
            self._request("DELETE", url)
        except HTTPError as err:
            if err.code == HTTP_NOT_FOUND or (
                err.code == HTTP_UNPROCESSABLE_CONTENT and _is_missing_ref_error(err)
            ):
                LOGGER.info("Ref %s was already deleted.", ref)
                return
            raise

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
) -> CleanupResult:
    """Clean workflow-owned stale pull requests and branches.

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

    Returns:
        Summary of cleanup actions.

    """
    result = CleanupResult()
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
    branches_to_delete: set[str] = set()

    latest_open_pr_number = (
        max(workflow_open_pull_numbers, default=None) if keep_latest_open_pr else None
    )
    for pull in workflow_open_pulls:
        pull_number = _pull_number(pull)
        head_ref = _head_ref(pull)

        if pull_number in {keep_pr_number, latest_open_pr_number}:
            protected_branches.add(head_ref)
            continue

        if not close_stale_prs:
            protected_branches.add(head_ref)
            continue

        client.close_pull(pull_number)
        result.closed_prs.append(pull_number)
        if _is_branch_head_sha_match(
            client=client,
            pull=pull,
            repository=repository,
        ):
            branches_to_delete.add(head_ref)

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
            if should_delete and _is_branch_head_sha_match(
                client=client,
                pull=pull,
                repository=repository,
            ):
                branches_to_delete.add(_head_ref(pull))

    branches_to_delete -= protected_branches
    for branch_name in sorted(branches_to_delete):
        client.delete_ref(f"heads/{branch_name}")
        result.deleted_branches.append(branch_name)

    return result


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


def _is_branch_head_sha_match(
    *,
    client: CleanupClient,
    pull: Mapping[str, object],
    repository: str,
) -> bool:
    """Return whether the current branch SHA still points to the PR head."""
    head_ref = _same_repo_head_ref(pull, repository=repository)
    if head_ref is None:
        return False
    branch_sha = client.get_ref_sha(ref=f"heads/{head_ref}")
    if branch_sha is None:
        return False
    pull_head_sha = _pull_head_sha(pull)
    return pull_head_sha is not None and branch_sha == pull_head_sha


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


def _is_missing_ref_error(err: HTTPError) -> bool:
    """Return whether a GitHub 422 error reports a missing ref.

    Args:
        err: HTTP error from the GitHub API.

    Returns:
        True when the error body says the reference does not exist.

    """
    body = err.read().decode(errors="replace")
    if not body:
        return False
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        return "Reference does not exist" in body
    if not isinstance(payload, dict):
        return False
    message = payload.get("message")
    return isinstance(message, str) and "Reference does not exist" in message


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
            delete_stale_branches=args.delete_stale_branches,
            delete_merged_branches=args.delete_merged_branches,
        )
    except (HTTPError, URLError, TimeoutError) as err:
        LOGGER.error(
            "Failed to clean prek update branches for %s branch %s: %s",
            args.repository,
            args.branch,
            err,
        )
        return 1
    LOGGER.info("Closed stale PRs: %s", result.closed_prs or "none")
    LOGGER.info("Deleted branches: %s", result.deleted_branches or "none")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

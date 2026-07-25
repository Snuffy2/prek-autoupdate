"""Dispatch update-branch workflows and remove duplicate approval-gated runs."""

from __future__ import annotations

import argparse
import json
import logging
import os
import time
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import TYPE_CHECKING, Protocol, cast
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

if TYPE_CHECKING:
    from collections.abc import Sequence

LOGGER = logging.getLogger(__name__)
DEFAULT_API_URL = "https://api.github.com"
DEFAULT_RETRY_ATTEMPTS = 5
DEFAULT_RETRY_DELAY = 2.0
LINK_PART_COUNT = 2

JsonObject = dict[str, object]


@dataclass(frozen=True)
class Workflow:
    """A GitHub Actions workflow."""

    id: int
    name: str
    path: str


@dataclass(frozen=True)
class Run:
    """The workflow-run fields needed to identify an approval gate."""

    id: int
    head_sha: str
    conclusion: str | None
    pull_request_numbers: frozenset[int]


class WorkflowApi(Protocol):
    """GitHub operations used by the dispatch workflow."""

    def list_workflows(self) -> list[Workflow]:
        """Return repository workflows."""

    def dispatch_workflow(self, workflow_id: int, ref: str) -> None:
        """Dispatch a workflow on a ref."""

    def list_pull_request_runs(self, workflow_id: int, branch: str) -> list[Run]:
        """Return pull-request runs for a workflow and branch."""

    def delete_run(self, run_id: int) -> None:
        """Delete a workflow run."""


class GitHubApi:
    """Minimal GitHub Actions REST API client."""

    def __init__(
        self,
        repository: str,
        token: str,
        *,
        api_url: str = DEFAULT_API_URL,
    ) -> None:
        """Initialize the client for one repository."""
        self._repository = repository
        self._token = token
        self._api_url = api_url.rstrip("/")

    def _request(
        self,
        method: str,
        path_or_url: str,
        payload: JsonObject | None = None,
    ) -> tuple[JsonObject, str | None]:
        url = (
            path_or_url
            if path_or_url.startswith(("https://", "http://"))
            else f"{self._api_url}/repos/{self._repository}/{path_or_url.lstrip('/')}"
        )
        data = json.dumps(payload).encode() if payload is not None else None
        request = Request(
            url,
            data=data,
            method=method,
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {self._token}",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )

        try:
            with urlopen(request, timeout=30) as response:
                raw_body = response.read()
                link = response.headers.get("Link")
        except HTTPError as err:
            detail = err.read().decode(errors="replace")
            message = f"GitHub API {method} {url} failed with HTTP {err.code}: {detail}"
            raise RuntimeError(message) from err

        if not raw_body:
            return {}, link

        decoded = cast("object", json.loads(raw_body))
        if not isinstance(decoded, dict):
            msg = f"GitHub API {method} {url} returned a non-object response"
            raise TypeError(msg)
        return cast("JsonObject", decoded), link

    def _paginate(self, path: str, key: str) -> list[JsonObject]:
        items: list[JsonObject] = []
        next_url: str | None = path
        while next_url is not None:
            payload, link = self._request("GET", next_url)
            page = payload.get(key)
            if not isinstance(page, list):
                msg = f"GitHub API response is missing list field {key!r}"
                raise TypeError(msg)
            for item in page:
                if not isinstance(item, dict):
                    msg = f"GitHub API field {key!r} contains a non-object item"
                    raise TypeError(msg)
                items.append(cast("JsonObject", item))
            next_url = _next_link(link)
        return items

    def list_workflows(self) -> list[Workflow]:
        """Return every workflow, following GitHub pagination."""
        payloads = self._paginate("actions/workflows?per_page=100", "workflows")
        return [
            Workflow(
                id=_required_int(payload, "id"),
                name=_required_str(payload, "name"),
                path=_required_str(payload, "path"),
            )
            for payload in payloads
        ]

    def dispatch_workflow(self, workflow_id: int, ref: str) -> None:
        """Dispatch a workflow on a ref."""
        self._request(
            "POST",
            f"actions/workflows/{workflow_id}/dispatches",
            {"ref": ref},
        )

    def list_pull_request_runs(self, workflow_id: int, branch: str) -> list[Run]:
        """Return pull-request runs for a workflow and branch."""
        query = urlencode(
            {
                "event": "pull_request",
                "branch": branch,
                "per_page": 100,
            }
        )
        payloads = self._paginate(
            f"actions/workflows/{workflow_id}/runs?{query}",
            "workflow_runs",
        )
        return [_run_from_payload(payload) for payload in payloads]

    def delete_run(self, run_id: int) -> None:
        """Delete a workflow run."""
        self._request("DELETE", f"actions/runs/{run_id}")


def _required_int(payload: JsonObject, key: str) -> int:
    value = payload.get(key)
    if not isinstance(value, int):
        msg = f"GitHub API object is missing integer field {key!r}"
        raise TypeError(msg)
    return value


def _required_str(payload: JsonObject, key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str):
        msg = f"GitHub API object is missing string field {key!r}"
        raise TypeError(msg)
    return value


def _run_from_payload(payload: JsonObject) -> Run:
    pull_requests = payload.get("pull_requests", [])
    if not isinstance(pull_requests, list):
        msg = "GitHub workflow run has an invalid pull_requests field"
        raise TypeError(msg)

    pull_request_numbers: set[int] = set()
    for pull_request in pull_requests:
        if not isinstance(pull_request, dict):
            msg = "GitHub workflow run contains an invalid pull request"
            raise TypeError(msg)
        number = pull_request.get("number")
        if not isinstance(number, int):
            msg = "GitHub workflow run pull request is missing its number"
            raise TypeError(msg)
        pull_request_numbers.add(number)

    conclusion = payload.get("conclusion")
    if conclusion is not None and not isinstance(conclusion, str):
        msg = "GitHub workflow run has an invalid conclusion"
        raise ValueError(msg)

    return Run(
        id=_required_int(payload, "id"),
        head_sha=_required_str(payload, "head_sha"),
        conclusion=conclusion,
        pull_request_numbers=frozenset(pull_request_numbers),
    )


def _next_link(link: str | None) -> str | None:
    if link is None:
        return None
    for item in link.split(","):
        parts = [part.strip() for part in item.split(";")]
        if len(parts) == LINK_PART_COUNT and parts[1] == 'rel="next"':
            return parts[0].removeprefix("<").removesuffix(">")
    return None


def resolve_workflow(identifier: str, workflows: Sequence[Workflow]) -> Workflow:
    """Resolve a workflow ID, display name, filename, or repository path."""
    matches = {
        workflow.id: workflow
        for workflow in workflows
        if identifier
        in {
            str(workflow.id),
            workflow.name,
            workflow.path,
            PurePosixPath(workflow.path).name,
        }
    }
    if not matches:
        msg = f"Workflow not found: {identifier}"
        raise ValueError(msg)
    if len(matches) > 1:
        msg = f"Workflow identifier is ambiguous: {identifier}"
        raise ValueError(msg)
    return next(iter(matches.values()))


def dispatch_workflows(
    api: WorkflowApi,
    *,
    identifiers: Sequence[str],
    ref: str,
    pr_number: int,
    head_sha: str,
    retry_attempts: int = DEFAULT_RETRY_ATTEMPTS,
    retry_delay: float = DEFAULT_RETRY_DELAY,
) -> None:
    """Dispatch workflows and delete their duplicate approval-required PR runs."""
    if retry_attempts < 1:
        msg = "retry_attempts must be at least 1"
        raise ValueError(msg)

    available_workflows = api.list_workflows()
    resolved = {
        workflow.id: workflow
        for workflow in (
            resolve_workflow(identifier, available_workflows) for identifier in identifiers
        )
    }

    for workflow in resolved.values():
        api.dispatch_workflow(workflow.id, ref)
        LOGGER.info("Dispatched %s on %s", workflow.name, ref)

    pending_workflow_ids = set(resolved)
    for attempt in range(retry_attempts):
        for workflow_id in tuple(pending_workflow_ids):
            matching_runs = [
                run
                for run in api.list_pull_request_runs(workflow_id, ref)
                if run.head_sha == head_sha
                and run.conclusion == "action_required"
                and pr_number in run.pull_request_numbers
            ]
            if not matching_runs:
                continue

            for run in matching_runs:
                api.delete_run(run.id)
                LOGGER.info(
                    "Deleted approval-required run %s for workflow %s",
                    run.id,
                    resolved[workflow_id].name,
                )
            pending_workflow_ids.remove(workflow_id)

        if not pending_workflow_ids:
            return
        if attempt < retry_attempts - 1:
            time.sleep(retry_delay)

    missing = ", ".join(resolved[workflow_id].name for workflow_id in pending_workflow_ids)
    LOGGER.info("No matching approval-required runs found for: %s", missing)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--ref", required=True)
    parser.add_argument("--pr-number", required=True, type=int)
    parser.add_argument("--head-sha", required=True)
    parser.add_argument("--workflow", action="append", required=True, dest="workflows")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Run the workflow dispatcher."""
    args = _parser().parse_args(argv)
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if not token:
        msg = "GITHUB_TOKEN or GH_TOKEN must be set"
        raise RuntimeError(msg)

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    api = GitHubApi(args.repository, token)
    dispatch_workflows(
        api,
        identifiers=args.workflows,
        ref=args.ref,
        pr_number=args.pr_number,
        head_sha=args.head_sha,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

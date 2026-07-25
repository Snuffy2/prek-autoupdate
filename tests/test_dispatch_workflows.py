"""Tests for dispatching update-branch workflows and clearing approval gates."""

import time
import urllib.request
from dataclasses import dataclass, field
from email.message import Message
from io import BytesIO
from runpy import run_module
from typing import Self
from urllib.error import HTTPError

import pytest

import prek_autoupdate.dispatch_workflows as subject
from prek_autoupdate.dispatch_workflows import (
    GitHubApi,
    Run,
    Workflow,
    dispatch_workflows,
    resolve_workflow,
)

REQUEST_TIMEOUT = 30


@dataclass
class FakeGitHubApi:
    """Record workflow API operations for deterministic tests."""

    workflows: list[Workflow]
    runs: dict[int, list[Run]]
    dispatched: list[tuple[int, str]] = field(default_factory=list)
    deleted: list[int] = field(default_factory=list)

    def list_workflows(self) -> list[Workflow]:
        """Return configured workflows."""
        return self.workflows

    def dispatch_workflow(self, workflow_id: int, ref: str) -> None:
        """Record a workflow dispatch."""
        self.dispatched.append((workflow_id, ref))

    def list_pull_request_runs(
        self,
        workflow_id: int,
        branch: str,
        head_sha: str,
        status: str,
    ) -> list[Run]:
        """Return runs for a workflow."""
        assert branch == "chore/prek-updates"
        assert head_sha == "expected-sha"
        assert status == "action_required"
        return self.runs.get(workflow_id, [])

    def delete_run(self, run_id: int) -> None:
        """Record deletion of an approval-required run."""
        self.deleted.append(run_id)


@pytest.fixture
def workflows() -> list[Workflow]:
    """Return representative repository workflows."""
    return [
        Workflow(id=101, name="Linters", path=".github/workflows/linters.yml"),
        Workflow(id=102, name="Validate", path=".github/workflows/validate.yml"),
    ]


@pytest.mark.parametrize(
    ("identifier", "expected_id"),
    [
        ("101", 101),
        ("Linters", 101),
        ("linters.yml", 101),
        (".github/workflows/linters.yml", 101),
    ],
)
def test_resolve_workflow_by_supported_identifier(
    workflows: list[Workflow],
    identifier: str,
    expected_id: int,
) -> None:
    """Workflow IDs, names, filenames, and paths resolve consistently."""
    assert resolve_workflow(identifier, workflows).id == expected_id


def test_resolve_workflow_rejects_unknown_identifier(
    workflows: list[Workflow],
) -> None:
    """An unknown workflow cannot silently dispatch the wrong target."""
    with pytest.raises(ValueError, match=r"Workflow not found: missing\.yml"):
        resolve_workflow("missing.yml", workflows)


def test_resolve_workflow_rejects_ambiguous_name() -> None:
    """Duplicate display names require a filename or ID."""
    duplicates = [
        Workflow(id=101, name="CI", path=".github/workflows/ci.yml"),
        Workflow(id=102, name="CI", path=".github/workflows/other.yml"),
    ]

    with pytest.raises(ValueError, match="Workflow identifier is ambiguous: CI"):
        resolve_workflow("CI", duplicates)


def test_dispatch_deletes_only_matching_approval_required_runs(
    workflows: list[Workflow],
) -> None:
    """Dispatched workflows replace only their exact gated PR runs."""
    api = FakeGitHubApi(
        workflows=workflows,
        runs={
            101: [
                Run(
                    id=1001,
                    head_sha="expected-sha",
                    conclusion="action_required",
                    pull_request_numbers=frozenset({447}),
                ),
                Run(
                    id=1002,
                    head_sha="other-sha",
                    conclusion="action_required",
                    pull_request_numbers=frozenset({447}),
                ),
                Run(
                    id=1003,
                    head_sha="expected-sha",
                    conclusion="success",
                    pull_request_numbers=frozenset({447}),
                ),
            ],
            102: [
                Run(
                    id=2001,
                    head_sha="expected-sha",
                    conclusion="action_required",
                    pull_request_numbers=frozenset({448}),
                ),
                Run(
                    id=2002,
                    head_sha="expected-sha",
                    conclusion="action_required",
                    pull_request_numbers=frozenset({447}),
                ),
            ],
        },
    )

    dispatch_workflows(
        api,
        identifiers=["linters.yml", "Validate"],
        ref="chore/prek-updates",
        pr_number=447,
        head_sha="expected-sha",
        retry_attempts=1,
        retry_delay=0,
    )

    assert api.dispatched == [
        (101, "chore/prek-updates"),
        (102, "chore/prek-updates"),
    ]
    assert api.deleted == [1001, 2002]


def test_dispatch_retries_until_approval_run_appears(
    workflows: list[Workflow],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A short API race does not leave the approval-required run behind."""

    class DelayedApi(FakeGitHubApi):
        attempts = 0

        def list_pull_request_runs(
            self,
            workflow_id: int,
            branch: str,
            head_sha: str,
            status: str,
        ) -> list[Run]:
            self.attempts += 1
            if self.attempts == 1:
                return []
            return super().list_pull_request_runs(workflow_id, branch, head_sha, status)

    api = DelayedApi(
        workflows=[workflows[0]],
        runs={
            101: [
                Run(
                    id=1001,
                    head_sha="expected-sha",
                    conclusion="action_required",
                    pull_request_numbers=frozenset({447}),
                )
            ]
        },
    )
    sleeps: list[float] = []
    monkeypatch.setattr(
        "prek_autoupdate.dispatch_workflows.time.sleep",
        sleeps.append,
    )

    dispatch_workflows(
        api,
        identifiers=["linters.yml"],
        ref="chore/prek-updates",
        pr_number=447,
        head_sha="expected-sha",
        retry_attempts=2,
        retry_delay=0.25,
    )

    assert sleeps == [0.25]
    assert api.deleted == [1001]


class FakeResponse:
    """Provide the urlopen response protocol."""

    def __init__(self, body: bytes, link: str | None = None) -> None:
        """Initialize a response body and optional pagination link."""
        self.body = body
        self.headers = {"Link": link} if link else {}

    def __enter__(self) -> Self:
        """Enter the mocked response context."""
        return self

    def __exit__(self, *_args: object) -> None:
        """Exit the mocked response context."""

    def read(self) -> bytes:
        """Return the configured response body."""
        return self.body


def test_github_api_requests_and_paginates(monkeypatch: pytest.MonkeyPatch) -> None:
    """The client follows next links and maps workflow and run payloads."""
    responses = iter(
        [
            FakeResponse(
                b'{"workflows":[{"id":1,"name":"CI","path":".github/workflows/ci.yml"}]}',
                '<https://next>; rel="next", <https://last>; rel="last"',
            ),
            FakeResponse(b'{"workflows":[{"id":2,"name":"Lint","path":"lint.yml"}]}'),
            FakeResponse(b""),
            FakeResponse(
                b'{"workflow_runs":[{"id":9,"head_sha":"abc","conclusion":null,'
                b'"pull_requests":[{"number":7}]}]}'
            ),
            FakeResponse(b""),
        ]
    )
    requests: list[object] = []

    def fake_urlopen(request: object, timeout: int) -> FakeResponse:
        assert timeout == REQUEST_TIMEOUT
        requests.append(request)
        return next(responses)

    monkeypatch.setattr(subject, "urlopen", fake_urlopen)
    api = GitHubApi("owner/repo", "secret", api_url="https://example/")

    assert [workflow.id for workflow in api.list_workflows()] == [1, 2]
    api.dispatch_workflow(1, "branch")
    assert api.list_pull_request_runs(1, "branch", "abc", "action_required") == [
        Run(9, "abc", None, frozenset({7}))
    ]
    api.delete_run(9)
    assert len(requests) == 5  # noqa: PLR2004
    assert isinstance(requests[3], urllib.request.Request)
    assert (
        requests[3].full_url == "https://example/repos/owner/repo/actions/workflows/1/runs"
        "?event=pull_request&branch=branch&head_sha=abc"
        "&status=action_required&per_page=100"
    )


def test_request_reports_http_and_invalid_json_shapes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Transport errors and non-object API documents are explicit."""
    api = GitHubApi("owner/repo", "token")
    error = HTTPError("https://api", 403, "no", Message(), BytesIO(b"denied"))
    monkeypatch.setattr(subject, "urlopen", lambda *_args, **_kwargs: (_ for _ in ()).throw(error))
    with pytest.raises(RuntimeError, match="HTTP 403: denied"):
        api.list_workflows()

    monkeypatch.setattr(subject, "urlopen", lambda *_args, **_kwargs: FakeResponse(b"[]"))
    with pytest.raises(TypeError, match="non-object response"):
        api.list_workflows()


@pytest.mark.parametrize(
    ("payload", "message"),
    [
        ({}, "missing list field"),
        ({"workflows": [1]}, "non-object item"),
        ({"workflows": [{"id": "1", "name": "CI", "path": "ci.yml"}]}, "integer field"),
        ({"workflows": [{"id": 1, "name": 2, "path": "ci.yml"}]}, "string field"),
    ],
)
def test_list_workflows_rejects_malformed_payload(
    monkeypatch: pytest.MonkeyPatch,
    payload: dict[str, object],
    message: str,
) -> None:
    """Malformed workflow payloads cannot reach dispatch."""
    monkeypatch.setattr(
        GitHubApi,
        "_request",
        lambda *_args, **_kwargs: (payload, None),
    )
    with pytest.raises(TypeError, match=message):
        GitHubApi("owner/repo", "token").list_workflows()


@pytest.mark.parametrize(
    ("payload", "exception", "message"),
    [
        ({"id": 1, "head_sha": "x", "pull_requests": {}}, TypeError, "invalid pull_requests"),
        ({"id": 1, "head_sha": "x", "pull_requests": [1]}, TypeError, "invalid pull request"),
        ({"id": 1, "head_sha": "x", "pull_requests": [{}]}, TypeError, "missing its number"),
        (
            {"id": 1, "head_sha": "x", "pull_requests": [], "conclusion": 1},
            ValueError,
            "invalid conclusion",
        ),
    ],
)
def test_run_payload_validation(
    payload: dict[str, object],
    exception: type[Exception],
    message: str,
) -> None:
    """Malformed workflow runs fail with contract-specific errors."""
    with pytest.raises(exception, match=message):
        subject._run_from_payload(payload)


def test_next_link_ignores_absent_and_unrelated_links() -> None:
    """Only a well-formed next relation drives pagination."""
    assert subject._next_link(None) is None
    assert subject._next_link('<https://last>; rel="last"') is None
    assert subject._next_link("malformed; x; y") is None


def test_dispatch_validates_retries_and_exhausts(
    workflows: list[Workflow],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Invalid retry counts fail and exhausted polling sleeps predictably."""
    api = FakeGitHubApi(workflows=[workflows[0]], runs={})
    with pytest.raises(ValueError, match="at least 1"):
        dispatch_workflows(
            api,
            identifiers=["CI"],
            ref="chore/prek-updates",
            pr_number=1,
            head_sha="expected-sha",
            retry_attempts=0,
        )
    sleeps: list[float] = []
    monkeypatch.setattr(time, "sleep", sleeps.append)
    dispatch_workflows(
        api,
        identifiers=["Linters", "101"],
        ref="chore/prek-updates",
        pr_number=1,
        head_sha="expected-sha",
        retry_attempts=2,
        retry_delay=0.1,
    )
    assert api.dispatched == [(101, "chore/prek-updates")]
    assert sleeps == [0.1]


def test_main_requires_token_and_dispatches(monkeypatch: pytest.MonkeyPatch) -> None:
    """CLI environment validation and successful wiring are covered."""
    argv = [
        "--repository",
        "owner/repo",
        "--ref",
        "branch",
        "--pr-number",
        "7",
        "--head-sha",
        "abc",
        "--workflow",
        "CI",
    ]
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    monkeypatch.delenv("GH_TOKEN", raising=False)
    with pytest.raises(RuntimeError, match="must be set"):
        subject.main(argv)

    monkeypatch.setenv("GH_TOKEN", "token")
    captured: dict[str, object] = {}
    monkeypatch.setattr(subject, "GitHubApi", lambda repository, token: (repository, token))
    monkeypatch.setattr(
        subject,
        "dispatch_workflows",
        lambda api, **kwargs: captured.update(api=api, **kwargs),
    )
    assert subject.main(argv) == 0
    assert captured["api"] == ("owner/repo", "token")


def test_module_entrypoint(monkeypatch: pytest.MonkeyPatch) -> None:
    """Direct module execution exits with the main return code."""
    responses = iter(
        [
            FakeResponse(b'{"workflows":[{"id":1,"name":"CI","path":"ci.yml"}]}'),
            FakeResponse(b""),
            FakeResponse(
                b'{"workflow_runs":[{"id":2,"head_sha":"abc",'
                b'"conclusion":"action_required","pull_requests":[{"number":7}]}]}'
            ),
            FakeResponse(b""),
        ]
    )
    monkeypatch.setattr(urllib.request, "urlopen", lambda *_args, **_kwargs: next(responses))
    monkeypatch.setenv("GITHUB_TOKEN", "token")
    monkeypatch.setattr(
        "sys.argv",
        [
            "dispatch_workflows",
            "--repository",
            "owner/repo",
            "--ref",
            "branch",
            "--pr-number",
            "7",
            "--head-sha",
            "abc",
            "--workflow",
            "CI",
        ],
    )
    with (
        pytest.warns(RuntimeWarning, match="found in sys.modules"),
        pytest.raises(SystemExit) as error,
    ):
        run_module(subject.__name__, run_name="__main__")
    assert error.value.code == 0

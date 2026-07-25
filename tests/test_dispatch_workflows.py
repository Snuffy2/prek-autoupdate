"""Tests for dispatching update-branch workflows and clearing approval gates."""

from dataclasses import dataclass, field

import pytest

from prek_autoupdate.dispatch_workflows import (
    Run,
    Workflow,
    dispatch_workflows,
    resolve_workflow,
)


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

    def list_pull_request_runs(self, workflow_id: int, branch: str) -> list[Run]:
        """Return runs for a workflow."""
        assert branch == "chore/prek-updates"
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

        def list_pull_request_runs(self, workflow_id: int, branch: str) -> list[Run]:
            self.attempts += 1
            if self.attempts == 1:
                return []
            return super().list_pull_request_runs(workflow_id, branch)

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

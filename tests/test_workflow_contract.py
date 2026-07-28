"""Tests for the reusable workflow's compatibility contract."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import yaml

WORKFLOW_TEXT = (
    Path(__file__).parents[1] / ".github" / "workflows" / "prek_autoupdate.yml"
).read_text()


class _WorkflowLoader(yaml.SafeLoader):
    """Load YAML 1.1 without coercing the GitHub Actions ``on`` key."""


_WorkflowLoader.yaml_implicit_resolvers = {
    key: [
        resolver
        for resolver in resolvers
        if not (key in {"o", "O"} and resolver[0] == "tag:yaml.org,2002:bool")
    ]
    for key, resolvers in yaml.SafeLoader.yaml_implicit_resolvers.items()
}

_loader = _WorkflowLoader(WORKFLOW_TEXT)
try:
    WORKFLOW: dict[str, Any] = _loader.get_single_data()
finally:
    _loader.dispose()  # type: ignore[no-untyped-call]


def _step(job_name: str, step_name: str) -> dict[str, Any]:
    """Return a named step from a workflow job."""
    steps = WORKFLOW["jobs"][job_name]["steps"]
    return next(step for step in steps if step["name"] == step_name)


def test_push_only_reconciles_obsolete_pull_requests() -> None:
    """Pushes should reconcile the PR without running prek auto-update."""
    update_day = _step("update-hooks", "Check update day")
    event_conditions = re.findall(
        r'\$\{\{ github\.event_name \}\}" == "([^"]+)"', update_day["run"]
    )
    assert event_conditions == ["workflow_dispatch", "schedule"]

    update_steps = WORKFLOW["jobs"]["update-hooks"]["steps"]
    gated_steps = [step for step in update_steps if step["name"] != "Check update day"]
    update_condition = "steps.update-day.outputs.should-update == 'true'"
    assert all(step["if"] == update_condition for step in gated_steps)

    cleanup = _step("cleanup", "Close stale prek update PRs")
    assert cleanup["env"]["EVENT_NAME"] == "${{ github.event_name }}"
    push_cleanup = (
        'if [[ "${EVENT_NAME}" == "push" ]]; then\n'
        "  args+=(--close-obsolete-prs)\n"
        "else\n"
        "  args+=(--close-stale-prs)\n"
        "fi"
    )
    assert push_cleanup in cleanup["run"]
    unconditional_args = cleanup["run"].split(
        'if [[ "${EVENT_NAME}" == "push" ]]; then', maxsplit=1
    )[0]
    assert "--close-stale-prs" not in unconditional_args
    assert "--close-obsolete-prs" not in unconditional_args


def test_deprecated_dispatch_workflows_input_is_accepted_but_ignored() -> None:
    """The retired input remains valid for callers but has no behavior."""
    dispatch_input = WORKFLOW["on"]["workflow_call"]["inputs"]["dispatch-workflows"]
    assert dispatch_input == {
        "description": "Deprecated compatibility input. Accepted but ignored.",
        "required": False,
        "type": "string",
        "default": "",
    }

    input_reference = re.compile(
        r"""inputs(?:\.dispatch-workflows|\[\s*(["'])dispatch-workflows\1\s*\])"""
    )
    assert input_reference.search(WORKFLOW_TEXT) is None

    jobs = WORKFLOW["jobs"].values()
    assert all(job.get("permissions", {}).get("actions") != "write" for job in jobs)

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("prek-autofix consumer workflows", () => {
  it("reviews untrusted pull requests with read-only permissions", () => {
    const workflow = parse(
      readFileSync(".github/workflows/prek-autofix-review.yml", "utf8"),
    );
    expect(workflow.name).toBe("prek-autofix");
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.on).not.toHaveProperty("workflow_dispatch");
    expect(workflow.jobs.review).not.toHaveProperty("name");
    expect(workflow.jobs).not.toHaveProperty("signal");
    const steps = workflow.jobs.review.steps;
    expect(steps[0].with).toEqual({
      "repository": "${{ github.event.pull_request.head.repo.full_name }}",
      "ref": "${{ github.event.pull_request.head.sha }}",
      "fetch-depth": 1,
      "persist-credentials": false,
    });
    expect(steps[1].run).toBe("npm ci --ignore-scripts");
    expect(steps[2].uses).toBe("Snuffy2/prek-autofix/review@v1");
  });

  it("keeps the privileged fix stage shell- and checkout-free", () => {
    const workflow = parse(
      readFileSync(".github/workflows/prek-autofix-fix.yml", "utf8"),
    );
    expect(workflow.name).toBe("prek-autofix fix");
    expect(workflow.on.workflow_run.workflows).toEqual(["prek-autofix"]);
    expect(workflow.permissions).toEqual({
      "actions": "read",
      "contents": "read",
      "pull-requests": "write",
    });
    expect(workflow.jobs.fix.if).toBe(
      "github.event.workflow_run.event == 'pull_request'",
    );
    const steps = workflow.jobs.fix.steps;
    expect(steps).toHaveLength(1);
    expect(steps[0].uses).toBe("Snuffy2/prek-autofix/fix@v1");
    expect(steps[0].with["source-workflow"]).toBe("prek-autofix");
    expect(steps[0]).not.toHaveProperty("env");
    expect(steps[0]).not.toHaveProperty("run");
  });
});

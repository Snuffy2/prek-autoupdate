import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("prek-autofix consumer workflows", () => {
  it("collects untrusted pull-request fixes with read-only permissions", () => {
    const workflow = parse(
      readFileSync(".github/workflows/prek-autofix.yml", "utf8"),
    );
    expect(workflow.permissions).toEqual({ contents: "read" });
    const steps = workflow.jobs.collect.steps;
    expect(steps[0].with["persist-credentials"]).toBe(false);
    expect(steps[1].run).toBe("npm ci --ignore-scripts");
    expect(steps[2].uses).toBe("Snuffy2/prek-autofix/collect@v1");
  });

  it("keeps the privileged apply stage shell- and checkout-free", () => {
    const workflow = parse(
      readFileSync(".github/workflows/prek-autofix-apply.yml", "utf8"),
    );
    expect(workflow.permissions).toEqual({
      "actions": "read",
      "contents": "read",
      "pull-requests": "write",
    });
    const steps = workflow.jobs.apply.steps;
    expect(steps).toHaveLength(1);
    expect(steps[0].uses).toBe("Snuffy2/prek-autofix/apply@v1");
    expect(steps[0]).not.toHaveProperty("run");
  });
});

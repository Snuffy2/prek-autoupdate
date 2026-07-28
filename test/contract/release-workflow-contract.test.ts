import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface ReleaseWorkflow {
  readonly permissions?: Record<string, string>;
  readonly jobs: {
    readonly "update-v2": {
      readonly concurrency: {
        readonly "group": string;
        readonly "cancel-in-progress": boolean;
      };
      readonly permissions: Record<string, string>;
      readonly steps: readonly {
        readonly uses?: string;
        readonly run?: string;
      }[];
    };
  };
}

const workflow = parse(
  readFileSync(".github/workflows/release.yml", "utf8"),
) as ReleaseWorkflow;

describe("release workflow", () => {
  it("limits write permission and serializes major-tag updates", () => {
    expect(workflow.permissions).toBeUndefined();
    expect(workflow.jobs["update-v2"].permissions).toEqual({
      contents: "write",
    });
    expect(workflow.jobs["update-v2"].concurrency).toEqual({
      "group": "update-v2-major-tag",
      "cancel-in-progress": false,
    });
  });

  it("checks out with project policy and safely advances v2", () => {
    const steps = workflow.jobs["update-v2"].steps;
    expect(steps.find((step) => step.uses)?.uses).toBe("actions/checkout@v7");

    const script = steps.find((step) => step.run)?.run;
    expect(script).toContain("/releases?per_page=100&page=${page}");
    expect(script).toContain("(.draft | not)");
    expect(script).toContain("(.prerelease | not)");
    expect(script).toContain('test("^v2\\\\.")');
    expect(script).toContain("git ls-remote --refs origin refs/tags/v2");
    expect(script).toContain(
      '--force-with-lease="refs/tags/v2:${observed_v2}"',
    );
    expect(script).not.toContain("git push --force origin");
  });
});

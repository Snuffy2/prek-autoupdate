import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface ReleaseWorkflow {
  readonly permissions?: Record<string, string>;
  readonly jobs: {
    readonly "update-major": {
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
    expect(workflow.jobs["update-major"].permissions).toEqual({
      contents: "write",
    });
    expect(workflow.jobs["update-major"].concurrency).toEqual({
      "group": "update-major-version-tag",
      "cancel-in-progress": false,
    });
  });

  it("checks out with project policy and safely advances the release major", () => {
    const steps = workflow.jobs["update-major"].steps;
    expect(steps.find((step) => step.uses)?.uses).toBe("actions/checkout@v7");

    const scripts = steps.flatMap((step) => step.run ?? []).join("\n");
    expect(scripts).toContain(
      String.raw`^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`,
    );
    expect(scripts).toContain(
      'echo "major_tag=v${BASH_REMATCH[1]}" >>"${GITHUB_OUTPUT}"',
    );
    expect(scripts).toContain("/releases?per_page=100&page=${page}");
    expect(scripts).toContain("(.draft | not)");
    expect(scripts).toContain("(.prerelease | not)");
    expect(scripts).toContain('"^" + $major_tag');
    expect(scripts).toContain(
      'git ls-remote --refs origin "refs/tags/${MAJOR_TAG}"',
    );
    expect(scripts).toContain(
      '--force-with-lease="refs/tags/${MAJOR_TAG}:${observed_major}"',
    );
    expect(scripts).toContain('origin "refs/tags/${MAJOR_TAG}"');
    expect(scripts).not.toContain("git push --force origin");
  });
});

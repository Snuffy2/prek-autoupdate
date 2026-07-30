import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface ReleaseWorkflow {
  readonly permissions?: Record<string, string>;
  readonly jobs: {
    readonly "update-major": {
      readonly if: string;
      readonly concurrency: {
        readonly "group": string;
        readonly "cancel-in-progress": boolean;
      };
      readonly permissions: Record<string, string>;
      readonly steps: readonly {
        readonly name: string;
        readonly id?: string;
        readonly if?: string;
        readonly env?: Record<string, string>;
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
    expect(workflow.jobs["update-major"].if).toBe(
      "${{ !github.event.release.draft && !github.event.release.prerelease }}",
    );
    expect(workflow.jobs["update-major"].concurrency).toEqual({
      "group": "update-major-version-tag",
      "cancel-in-progress": false,
    });
  });

  it("checks out with project policy and safely advances the release major", () => {
    const steps = workflow.jobs["update-major"].steps;
    expect(steps).toHaveLength(3);

    const [resolver, checkout, move] = steps;
    expect(resolver.name).toBe("Resolve major version tag");
    expect(resolver.id).toBe("version");
    expect(resolver.env).toEqual({
      RELEASE_TAG: "${{ github.event.release.tag_name }}",
    });
    expect(resolver.run).toContain(
      String.raw`^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`,
    );
    expect(resolver.run).toContain(
      'echo "major_tag=v${BASH_REMATCH[1]}" >>"${GITHUB_OUTPUT}"',
    );
    expect(resolver.run).toContain('echo "valid=true" >>"${GITHUB_OUTPUT}"');
    expect(resolver.run).toContain('echo "valid=false" >>"${GITHUB_OUTPUT}"');

    expect(checkout.name).toBe("Checkout release");
    expect(checkout.if).toBe("${{ steps.version.outputs.valid == 'true' }}");
    expect(checkout.uses).toBe("actions/checkout@v7");

    expect(move.name).toBe("Move major tag to the released commit");
    expect(move.if).toBe("${{ steps.version.outputs.valid == 'true' }}");
    expect(move.env?.MAJOR_TAG).toBe("${{ steps.version.outputs.major_tag }}");
    expect(move.run).toContain("/releases?per_page=100&page=${page}");
    expect(move.run).toContain("(.draft | not)");
    expect(move.run).toContain("(.prerelease | not)");
    expect(move.run).toContain('"^" + $major_tag');
    expect(move.run).toContain(
      'git ls-remote --refs origin "refs/tags/${MAJOR_TAG}"',
    );
    expect(move.run).toContain(
      '--force-with-lease="refs/tags/${MAJOR_TAG}:${observed_major}"',
    );
    expect(move.run).toContain('origin "refs/tags/${MAJOR_TAG}"');
    expect(move.run).not.toContain("git push --force origin");
  });
});

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface CallerWorkflow {
  readonly concurrency: {
    readonly "cancel-in-progress": boolean;
    readonly "group": string;
  };
  readonly jobs: Record<
    string,
    {
      readonly permissions?: Record<string, string>;
      readonly steps?: Array<{
        readonly uses?: string;
        readonly with?: Record<string, unknown>;
      }>;
    }
  >;
  readonly on: Record<string, unknown>;
  readonly permissions: Record<string, string>;
}

const readme = readFileSync("README.md", "utf8");
const selfWorkflow = parse(
  readFileSync(".github/workflows/prek_autoupdate_self.yml", "utf8"),
) as CallerWorkflow;

describe("documented caller", () => {
  it("is a complete safe direct-action workflow", () => {
    const match = /```yaml\n(?<yaml>[\s\S]*?)\n```/u.exec(readme);
    expect(match?.groups?.yaml).toBeDefined();
    const workflow = parse(match?.groups?.yaml ?? "") as CallerWorkflow;
    const steps = workflow.jobs["prek-autoupdate"]?.steps ?? [];
    const checkout = steps.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );

    expect(Object.keys(workflow.on)).toEqual(
      expect.arrayContaining(["schedule", "push", "workflow_dispatch"]),
    );
    expect(workflow.permissions).toEqual({
      "contents": "write",
      "pull-requests": "write",
    });
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
    expect(checkout?.uses).toBe("actions/checkout@v7");
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
    expect(steps).toContainEqual(
      expect.objectContaining({ uses: "Snuffy2/prek-autoupdate@v2" }),
    );
  });

  it("keeps the repository caller aligned with the documented concurrency and checkout contract", () => {
    const job = selfWorkflow.jobs["prek-autoupdate"];
    const steps = job?.steps ?? [];
    const checkout = steps.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );

    expect(selfWorkflow.concurrency).toEqual({
      "group": "prek-autoupdate-${{ github.repository }}",
      "cancel-in-progress": false,
    });
    expect(job?.permissions).toEqual({
      "contents": "write",
      "pull-requests": "write",
    });
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
    expect(steps).toContainEqual(expect.objectContaining({ uses: "./" }));
  });
});

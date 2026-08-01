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

function documentedWorkflow(): CallerWorkflow {
  const yamlBlocks = [...readme.matchAll(/```yaml\n(?<yaml>[\s\S]*?)\n```/gu)];
  const example = yamlBlocks.find((match) =>
    match.groups?.yaml.includes("Snuffy2/prek-autoupdate@v2"),
  );

  expect(example?.groups?.yaml).toBeDefined();
  return parse(example?.groups?.yaml ?? "") as CallerWorkflow;
}

describe("documented caller", () => {
  it("is a complete safe direct-action workflow", () => {
    const workflow = documentedWorkflow();
    const job = Object.values(workflow.jobs).find((candidate) =>
      candidate.steps?.some(
        (step) => step.uses === "Snuffy2/prek-autoupdate@v2",
      ),
    );
    const steps = job?.steps ?? [];
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
    expect(workflow.concurrency.group).toBeTruthy();
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
    expect(checkout?.uses).toBe("actions/checkout@v7");
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
    expect(steps).toContainEqual(
      expect.objectContaining({ uses: "Snuffy2/prek-autoupdate@v2" }),
    );
  });

  it("keeps the repository caller aligned with the documented concurrency and checkout contract", () => {
    const job = Object.values(selfWorkflow.jobs).find((candidate) =>
      candidate.steps?.some((step) => step.uses === "./"),
    );
    const steps = job?.steps ?? [];
    const checkout = steps.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );

    expect(selfWorkflow.concurrency.group).toBeTruthy();
    expect(selfWorkflow.concurrency["cancel-in-progress"]).toBe(false);
    expect(job?.permissions).toEqual({
      "contents": "write",
      "pull-requests": "write",
    });
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
    expect(steps).toContainEqual(expect.objectContaining({ uses: "./" }));
  });
});

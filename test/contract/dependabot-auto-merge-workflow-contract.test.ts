import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

interface Step {
  run?: string;
  uses?: string;
}

interface Job {
  if?: string;
  needs?: string | string[];
  permissions: Record<string, string>;
  steps: Step[];
}

interface Workflow {
  jobs: Record<string, Job>;
}

function workflow(filename = "dependabot-auto-merge.yml"): Workflow {
  return parse(
    readFileSync(`.github/workflows/${filename}`, "utf8"),
  ) as Workflow;
}

function normalizedCondition(job: Job): string {
  return (job.if ?? "").replaceAll(/\s+/gu, " ").trim();
}

function requiredJobWithCommand(
  parsedWorkflow: Workflow,
  command: string,
): Job {
  const job = Object.values(parsedWorkflow.jobs).find((candidate) =>
    candidate.steps.some((step) => step.run?.includes(command)),
  );
  if (job === undefined) {
    throw new Error(`Workflow has no job that runs ${command}`);
  }
  return job;
}

function requiredStepWithCommand(job: Job, command: string): Step {
  const step = job.steps.find((candidate) => candidate.run?.includes(command));
  if (step === undefined) {
    throw new Error(`Job has no step that runs ${command}`);
  }
  return step;
}

function requiredNeeds(job: Job): string[] {
  if (job.needs === undefined) {
    throw new Error("Write-capable job has no verification dependency");
  }
  return typeof job.needs === "string" ? [job.needs] : job.needs;
}

function verifyChangedFiles(script: string, changedFiles: string[]): number {
  const directory = mkdtempSync(join(tmpdir(), "dependabot-file-check-"));
  const ghPath = join(directory, "gh");
  writeFileSync(
    ghPath,
    "#!/usr/bin/env bash\nprintf '%s\\n' \"${CHANGED_FILES}\"\n",
  );
  chmodSync(ghPath, 0o755);

  try {
    return (
      spawnSync("bash", ["-euo", "pipefail", "-c", script], {
        env: {
          ...process.env,
          CHANGED_FILES: changedFiles.join("\n"),
          GH_TOKEN: "test-token",
          PATH: `${directory}:${process.env.PATH ?? ""}`,
          PR_NUMBER: "1",
          REPOSITORY: "owner/repository",
        },
        encoding: "utf8",
      }).status ?? 1
    );
  } finally {
    rmSync(directory, { recursive: true });
  }
}

describe("Dependabot auto-merge workflow", () => {
  it("keeps Node CI eligible for Dependabot pull requests", () => {
    const nodeCi = workflow("ci.yml").jobs.node;

    expect(normalizedCondition(nodeCi)).toContain(
      "github.event.pull_request.user.login == 'dependabot[bot]'",
    );
    expect(nodeCi.permissions).toEqual({
      "contents": "read",
      "pull-requests": "read",
    });
    expect(requiredStepWithCommand(nodeCi, "gh api --paginate")).toBeDefined();
  });

  it("gates auto-merge behind read-only ownership and content checks", () => {
    const dependabotWorkflow = workflow();
    const enable = requiredJobWithCommand(
      dependabotWorkflow,
      "gh pr merge --auto",
    );
    const verificationNames = requiredNeeds(enable);
    const verificationJobs = verificationNames.map(
      (name) => dependabotWorkflow.jobs[name],
    );
    const verificationSteps = verificationJobs.flatMap((job) => job.steps);

    expect(verificationJobs).not.toHaveLength(0);
    for (const verification of verificationJobs) {
      const condition = normalizedCondition(verification);
      expect(condition).toContain(
        "github.event.pull_request.user.login == 'dependabot[bot]'",
      );
      expect(condition).toContain(
        "github.event.pull_request.head.repo.full_name == github.repository",
      );
      expect(condition).toContain(
        "github.event.pull_request.base.ref == github.event.repository.default_branch",
      );
      expect(verification.permissions).toEqual({
        "contents": "read",
        "pull-requests": "read",
      });
    }
    expect(
      verificationSteps.some((step) =>
        step.uses?.startsWith("dependabot/fetch-metadata@"),
      ),
    ).toBe(true);
    expect(
      verificationSteps.some((step) => step.run?.includes("gh api --paginate")),
    ).toBe(true);
  });

  it.each([
    [["package-lock.json"], true],
    [["package.json", "package-lock.json"], true],
    [[".github/workflows/ci.yml"], true],
    [[], false],
    [["package.json"], false],
    [["package-lock.json", "src/index.ts"], false],
    [[".github/workflows/nested/ci.yml"], false],
    [["action.yml"], false],
  ])(
    "accepts only supported dependency files: %j",
    (changedFiles, accepted) => {
      const scripts = [
        requiredStepWithCommand(
          requiredJobWithCommand(workflow(), "gh api --paginate"),
          "gh api --paginate",
        ).run,
        requiredStepWithCommand(
          workflow("ci.yml").jobs.node,
          "gh api --paginate",
        ).run,
      ];

      for (const script of scripts) {
        expect(script).toBeDefined();
        const status = verifyChangedFiles(script ?? "", changedFiles);
        if (accepted) {
          expect(status).toBe(0);
        } else {
          expect(status).not.toBe(0);
        }
      }
    },
  );

  it("revokes failed eligibility without mutating a cancelled run", () => {
    const dependabotWorkflow = workflow();
    const enable = requiredJobWithCommand(
      dependabotWorkflow,
      "gh pr merge --auto",
    );
    const cleanup = requiredJobWithCommand(
      dependabotWorkflow,
      "gh pr merge --disable-auto",
    );
    const verificationNames = requiredNeeds(enable);
    const cleanupCondition = normalizedCondition(cleanup);

    expect(requiredNeeds(cleanup).toSorted()).toEqual(
      verificationNames.toSorted(),
    );
    expect(cleanupCondition).toContain("failure() && !cancelled()");
    for (const verificationName of verificationNames) {
      expect(cleanupCondition).toContain(
        `needs.${verificationName}.result == 'failure'`,
      );
    }
    expect(cleanupCondition).toContain(
      "github.event.pull_request.user.login == 'dependabot[bot]'",
    );
    expect(cleanup.permissions).toEqual({
      "contents": "write",
      "pull-requests": "write",
    });
  });
});

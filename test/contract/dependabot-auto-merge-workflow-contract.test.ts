import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { authorizeDependabotUpdate } from "../../.github/scripts/dependabot-auto-merge.mjs";

const dependabotSha = "1".repeat(40);
const firstBaseSha = "2".repeat(40);
const firstUpdateSha = "3".repeat(40);
const currentBaseSha = "4".repeat(40);
const headSha = "5".repeat(40);
const temporaryDirectories: string[] = [];

function pullRequestEvent(headRef: string, action = "synchronize") {
  return {
    action,
    repository: {
      default_branch: "main",
      fork: false,
      full_name: "Snuffy2/prek-autoupdate",
    },
    pull_request: {
      base: { ref: "main", sha: currentBaseSha },
      head: {
        ref: headRef,
        repo: { full_name: "Snuffy2/prek-autoupdate" },
        sha: headSha,
      },
      user: { login: "dependabot[bot]" },
    },
  };
}

function dependabotCommit(sha = headSha) {
  return {
    author: { login: "dependabot[bot]" },
    commit: { verification: { verified: true } },
    committer: { login: "web-flow" },
    parents: [],
    sha,
  };
}

function updateCommit(sha: string, previous: string, base: string) {
  return {
    author: { login: "Snuffy2" },
    commit: { verification: { verified: true } },
    committer: { login: "web-flow" },
    parents: [{ sha: previous }, { sha: base }],
    sha,
  };
}

function ancestryProof(parentSha: string, status = "ahead") {
  return {
    ahead_by: status === "identical" ? 0 : 1,
    base_commit: parentSha,
    base_sha: currentBaseSha,
    behind_by: 0,
    head_commit: currentBaseSha,
    merge_base_commit: parentSha,
    parent_sha: parentSha,
    status,
  };
}

function updateChain() {
  return [
    dependabotCommit(dependabotSha),
    updateCommit(firstUpdateSha, dependabotSha, firstBaseSha),
    updateCommit(headSha, firstUpdateSha, currentBaseSha),
  ];
}

function updateChainProofs() {
  return [
    ancestryProof(firstBaseSha),
    ancestryProof(currentBaseSha, "identical"),
  ];
}

function trustedBaseWith(...paths: string[]) {
  const directory = mkdtempSync(join(tmpdir(), "dependabot-authorizer-"));
  temporaryDirectories.push(directory);
  for (const path of paths) {
    const file = join(directory, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "fixture\n");
  }
  return directory;
}

function authorize({
  ancestryProofs = [],
  changedFiles = ["package-lock.json"],
  commits = [dependabotCommit()],
  event = pullRequestEvent("dependabot/npm_and_yarn/vitest-4.1.11", "reopened"),
  trustedBaseDirectory = trustedBaseWith("package.json", "package-lock.json"),
}: {
  ancestryProofs?: object[];
  changedFiles?: string[];
  commits?: object[];
  event?: ReturnType<typeof pullRequestEvent>;
  trustedBaseDirectory?: string;
} = {}) {
  return authorizeDependabotUpdate({
    ancestryProofs,
    changedFiles,
    commits,
    event,
    trustedBaseDirectory,
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

interface WorkflowStep {
  env?: Record<string, string>;
  if?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string | boolean>;
}

interface WorkflowJob {
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
}

interface Workflow {
  jobs: Record<string, WorkflowJob>;
}

interface NamedJob {
  id: string;
  job: WorkflowJob;
}

function workflow(filename: string): Workflow {
  return parse(
    readFileSync(`.github/workflows/${filename}`, "utf8"),
  ) as Workflow;
}

function requiredSteps(job: WorkflowJob): WorkflowStep[] {
  if (job.steps === undefined) throw new Error("Workflow job has no steps");
  return job.steps;
}

function authorizationStep(job: WorkflowJob): WorkflowStep {
  const step = requiredSteps(job).find((candidate) =>
    candidate.run?.includes("dependabot-auto-merge.mjs"),
  );
  if (step === undefined) throw new Error("Workflow has no authorization step");
  return step;
}

function requiresDependabotAuthor(condition: string | undefined) {
  expect(condition).toContain(
    "github.event.pull_request.user.login == 'dependabot[bot]'",
  );
}

function requiresNormalCiDependabotPullRequest(condition: string | undefined) {
  expect(condition).toContain("github.event_name == 'pull_request'");
  requiresDependabotAuthor(condition);
}

function requiresCleanupEligibility(condition: string | undefined) {
  requiresDependabotAuthor(condition);
  for (const term of [
    "repository.fork == false",
    "pull_request.head.repo.full_name == github.repository",
    "pull_request.base.ref == github.event.repository.default_branch",
  ])
    expect(condition).toContain(term);
}

function namedJobs(workflow: Workflow): NamedJob[] {
  return Object.entries(workflow.jobs).map(([id, job]) => ({ id, job }));
}

function requiredJob(jobs: NamedJob[], description: string): NamedJob {
  expect(jobs).toHaveLength(1);
  const [job] = jobs;
  if (job === undefined) throw new Error(`Workflow has no ${description} job`);
  return job;
}

function authorizationJob(workflow: Workflow): NamedJob {
  return requiredJob(
    namedJobs(workflow).filter(
      ({ job }) =>
        job.permissions?.contents === "read" &&
        job.permissions?.["pull-requests"] === "read" &&
        requiredSteps(job).some((step) =>
          step.run?.includes("dependabot-auto-merge.mjs"),
        ),
    ),
    "read-only authorization",
  );
}

function needs(job: WorkflowJob): string[] {
  if (job.needs === undefined) return [];
  return Array.isArray(job.needs) ? job.needs : [job.needs];
}

function writeJobs(workflow: Workflow): NamedJob[] {
  return namedJobs(workflow).filter(
    ({ job }) =>
      job.permissions?.contents === "write" ||
      job.permissions?.["pull-requests"] === "write",
  );
}

function trustedCheckoutPrecedesAuthorization(
  job: WorkflowJob,
  assertsEligibility: (condition: string | undefined) => void,
) {
  const steps = requiredSteps(job);
  const authorizationIndex = steps.indexOf(authorizationStep(job));
  const trustedCheckout = steps
    .slice(0, authorizationIndex)
    .find(
      (step) =>
        step.uses?.startsWith("actions/checkout@") &&
        step.with?.ref === "${{ github.event.pull_request.base.sha }}",
    );
  assertsEligibility(trustedCheckout?.if ?? job.if);
  expect(trustedCheckout?.with?.["persist-credentials"]).toBe(false);
}

function assertsAncestryDataflow(job: WorkflowJob) {
  const authorization = authorizationStep(job);
  const run = authorization.run;
  expect(authorization.env?.BASE_SHA).toBe(
    "${{ github.event.pull_request.base.sha }}",
  );
  expect(run).toContain('base_sha="${BASE_SHA}"');
  expect(run).toContain("pulls/${PR_NUMBER}/files");
  expect(run).toContain("pulls/${PR_NUMBER}/commits");
  expect(run).toContain("compare/${second_parent}...${base_sha}");
  expect(run).toContain("dependabot-auto-merge.mjs");
}

describe("Dependabot auto-merge authorization", () => {
  it("authorizes a reopened direct update from verified exact history", () => {
    expect(authorize()).toBe("npm");
  });

  it("does not use the triggering actor or action as authorization inputs", () => {
    for (const [actor, action] of [
      ["dependabot[bot]", "opened"],
      ["maintainer", "synchronize"],
      ["any-user", "reopened"],
    ]) {
      const input = {
        actor,
        ancestryProofs: [],
        changedFiles: ["package-lock.json"],
        commits: [dependabotCommit()],
        event: pullRequestEvent(
          "dependabot/npm_and_yarn/vitest-4.1.11",
          action,
        ),
        trustedBaseDirectory: trustedBaseWith(
          "package.json",
          "package-lock.json",
        ),
      };
      expect(authorizeDependabotUpdate(input)).toBe("npm");
    }
  });

  it("rejects missing or maintainer committers for a direct Dependabot root", () => {
    for (const root of [
      { ...dependabotCommit(), committer: undefined },
      { ...dependabotCommit(), committer: { login: "maintainer" } },
    ])
      expect(() => authorize({ commits: [root] })).toThrow();
  });

  it("authorizes npm lock-only updates from an npm base", () => {
    expect(
      authorize({
        changedFiles: ["package-lock.json"],
        trustedBaseDirectory: trustedBaseWith(
          "package.json",
          "package-lock.json",
        ),
      }),
    ).toBe("npm");
  });

  it("authorizes npm manifest and lockfile updates together", () => {
    expect(
      authorize({
        changedFiles: ["package.json", "package-lock.json"],
        trustedBaseDirectory: trustedBaseWith(
          "package.json",
          "package-lock.json",
        ),
      }),
    ).toBe("npm");
  });

  it("rejects manifest-only npm updates", () => {
    expect(() =>
      authorize({
        changedFiles: ["package.json"],
        trustedBaseDirectory: trustedBaseWith(
          "package.json",
          "package-lock.json",
        ),
      }),
    ).toThrow();
  });

  it("rejects npm updates with extra or repeated files", () => {
    const trustedBaseDirectory = trustedBaseWith(
      "package.json",
      "package-lock.json",
    );
    for (const changedFiles of [
      ["package-lock.json", "README.md"],
      ["package-lock.json", "package-lock.json"],
    ])
      expect(() =>
        authorize({
          changedFiles,
          trustedBaseDirectory,
        }),
      ).toThrow();
  });

  it("rejects cross-ecosystem updates from a mismatched trusted base", () => {
    expect(() =>
      authorize({
        changedFiles: ["uv.lock"],
        event: pullRequestEvent("dependabot/uv/pytest-9.0.0", "reopened"),
        trustedBaseDirectory: trustedBaseWith(
          "package.json",
          "package-lock.json",
        ),
      }),
    ).toThrow();
    expect(() =>
      authorize({
        changedFiles: ["package-lock.json"],
        trustedBaseDirectory: trustedBaseWith("uv.lock"),
      }),
    ).toThrow();
  });

  it("authorizes existing trusted workflow and action manifests", () => {
    const trustedBaseDirectory = trustedBaseWith(
      ".github/workflows/ci.yml",
      "actions/release/action.yaml",
      "action.yml",
    );
    for (const changedFiles of [
      [".github/workflows/ci.yml"],
      ["actions/release/action.yaml"],
      ["action.yml"],
    ])
      expect(
        authorize({
          changedFiles,
          event: pullRequestEvent(
            "dependabot/github_actions/actions/checkout-7",
            "reopened",
          ),
          trustedBaseDirectory,
        }),
      ).toBe("github-actions");
  });

  it("rejects untrusted GitHub Actions paths", () => {
    const trustedBaseDirectory = trustedBaseWith(
      ".github/workflows/nested/ci.yml",
      "action.yml",
    );
    for (const changedFiles of [
      [".github/workflows/nested/ci.yml"],
      ["../action.yml"],
    ])
      expect(() =>
        authorize({
          changedFiles,
          event: pullRequestEvent(
            "dependabot/github_actions/actions/checkout-7",
            "reopened",
          ),
          trustedBaseDirectory,
        }),
      ).toThrow();
  });

  it("authorizes a reopened verified GitHub Update branch chain", () => {
    expect(
      authorize({
        ancestryProofs: updateChainProofs(),
        commits: updateChain(),
        trustedBaseDirectory: trustedBaseWith(
          "package.json",
          "package-lock.json",
        ),
      }),
    ).toBe("npm");
  });

  it("rejects missing or maintainer committers for an Update branch root", () => {
    for (const root of [
      { ...dependabotCommit(dependabotSha), committer: undefined },
      {
        ...dependabotCommit(dependabotSha),
        committer: { login: "maintainer" },
      },
    ]) {
      const commits: object[] = updateChain();
      commits[0] = root;
      expect(() =>
        authorize({ ancestryProofs: updateChainProofs(), commits }),
      ).toThrow();
    }
  });

  it("rejects absent, arbitrary, diverged, and mismatched ancestry evidence", () => {
    for (const ancestryProofs of [
      [],
      [{}, ancestryProof(currentBaseSha, "identical")],
      [ancestryProof(firstBaseSha), ancestryProof("9".repeat(40))],
      [
        ancestryProof(firstBaseSha, "diverged"),
        ancestryProof(currentBaseSha, "identical"),
      ],
      [
        { ...ancestryProof(firstBaseSha), head_commit: "8".repeat(40) },
        ancestryProof(currentBaseSha, "identical"),
      ],
    ])
      expect(() =>
        authorize({ ancestryProofs, commits: updateChain() }),
      ).toThrow();
  });

  it("rejects an invalid GitHub Update branch chain", () => {
    expect(() =>
      authorize({
        ancestryProofs: [ancestryProof(currentBaseSha, "identical")],
        commits: [
          dependabotCommit(dependabotSha),
          {
            author: { login: "Snuffy2" },
            commit: { verification: { verified: true } },
            committer: { login: "Snuffy2" },
            parents: [{ sha: dependabotSha }, { sha: currentBaseSha }],
            sha: headSha,
          },
        ],
        trustedBaseDirectory: trustedBaseWith(
          "package.json",
          "package-lock.json",
        ),
      }),
    ).toThrow();
  });
});

describe("Dependabot workflow trust contracts", () => {
  it("authorizes eligible Dependabot PRs from trusted base data in both gates", () => {
    const autoMerge = workflow("dependabot-auto-merge.yml");
    const ci = workflow("ci.yml");
    const autoMergeAuthorization = authorizationJob(autoMerge);
    const ciAuthorization = authorizationJob(ci);

    expect(autoMergeAuthorization.job.permissions).toMatchObject({
      "contents": "read",
      "pull-requests": "read",
    });
    expect(ciAuthorization.job.permissions).toMatchObject({
      "contents": "read",
      "pull-requests": "read",
    });
    requiresDependabotAuthor(autoMergeAuthorization.job.if);
    requiresNormalCiDependabotPullRequest(
      authorizationStep(ciAuthorization.job).if,
    );
    trustedCheckoutPrecedesAuthorization(
      autoMergeAuthorization.job,
      requiresDependabotAuthor,
    );
    trustedCheckoutPrecedesAuthorization(
      ciAuthorization.job,
      requiresNormalCiDependabotPullRequest,
    );
    assertsAncestryDataflow(autoMergeAuthorization.job);
    assertsAncestryDataflow(ciAuthorization.job);
  });

  it("keeps write-capable auto-merge operations dependent on authorization", () => {
    const autoMerge = workflow("dependabot-auto-merge.yml");
    const authorization = authorizationJob(autoMerge);
    const writers = writeJobs(autoMerge);
    const enable = requiredJob(
      writers.filter(({ job }) =>
        requiredSteps(job).some((step) =>
          step.run?.includes("gh pr merge --auto"),
        ),
      ),
      "auto-merge writer",
    );

    expect(needs(enable.job)).toContain(authorization.id);
    expect(enable.job.permissions).toMatchObject({
      "contents": "write",
      "pull-requests": "write",
    });
    for (const writer of writers) {
      expect(needs(writer.job)).toContain(authorization.id);
      expect(
        requiredSteps(writer.job).some((step) =>
          step.uses?.startsWith("actions/checkout@"),
        ),
      ).toBe(false);
    }
  });

  it("only cleans up eligible failed runs and never cancelled runs", () => {
    const autoMerge = workflow("dependabot-auto-merge.yml");
    const authorization = authorizationJob(autoMerge);
    const cleanup = requiredJob(
      writeJobs(autoMerge).filter(({ job }) =>
        requiredSteps(job).some((step) =>
          step.run?.includes("gh pr merge --disable-auto"),
        ),
      ),
      "cleanup writer",
    );

    expect(needs(cleanup.job)).toContain(authorization.id);
    expect(cleanup.job.if).toContain("failure()");
    expect(cleanup.job.if).toContain("!cancelled()");
    requiresCleanupEligibility(cleanup.job.if);
  });

  it("authorizes Dependabot before CI checks out the pull-request revision", () => {
    const ciAuthorization = authorizationJob(workflow("ci.yml"));
    const steps = requiredSteps(ciAuthorization.job);
    const authorizationIndex = steps.indexOf(
      authorizationStep(ciAuthorization.job),
    );
    const headCheckoutIndex = steps.findIndex(
      (step) =>
        step.uses?.startsWith("actions/checkout@") &&
        step.with?.ref
          ?.toString()
          .includes("github.event.pull_request.head.sha"),
    );

    expect(headCheckoutIndex).toBeGreaterThan(authorizationIndex);
  });
});

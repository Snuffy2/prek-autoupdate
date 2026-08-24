import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface WorkflowStep {
  readonly env?: Record<string, string>;
  readonly id?: string;
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
}

interface WorkflowJob {
  readonly if?: string;
  readonly permissions?: Record<string, string>;
  readonly steps: WorkflowStep[];
}

interface Workflow {
  readonly on: {
    readonly workflow_dispatch: {
      readonly inputs: Record<string, Record<string, unknown>>;
    };
  };
  readonly permissions: Record<string, string>;
  readonly jobs: {
    readonly "prepare": WorkflowJob;
    readonly "finalize": WorkflowJob;
    readonly "publish": WorkflowJob;
    readonly "update-major": WorkflowJob;
  };
}

const RELEASE_DECISION_SCRIPT = resolve(".github/scripts/decide-major-tag.mjs");

function workflow(): Workflow {
  return parse(
    readFileSync(".github/workflows/release.yml", "utf8"),
  ) as Workflow;
}

function decideRelease(
  releaseTag: string,
  targetSha: string,
  tags: Array<{ name: string; commit: { sha: string } }>,
  releases: Array<{
    tag_name: string;
    draft: boolean;
    prerelease: boolean;
    published_at: string | null;
  }> = tags
    .filter((tag) => /^v[0-9]+\.[0-9]+\.[0-9]+$/.test(tag.name))
    .map((tag) => ({
      tag_name: tag.name,
      draft: false,
      prerelease: false,
      published_at: "2026-01-01T00:00:00Z",
    })),
): string {
  const directory = mkdtempSync(join(tmpdir(), "prek-autoupdate-release-"));
  const tagsFile = join(directory, "tags.json");
  const releasesFile = join(directory, "releases.json");
  writeFileSync(tagsFile, JSON.stringify([tags.slice(0, 1), tags.slice(1)]));
  writeFileSync(
    releasesFile,
    JSON.stringify([releases.slice(0, 1), releases.slice(1)]),
  );
  try {
    return execFileSync(process.execPath, [RELEASE_DECISION_SCRIPT], {
      encoding: "utf8",
      env: {
        ...process.env,
        RELEASE_TAG: releaseTag,
        TARGET_SHA: targetSha,
        TAGS_FILE: tagsFile,
        RELEASES_FILE: releasesFile,
      },
    });
  } finally {
    rmSync(directory, { recursive: true });
  }
}

function prepareRelease(
  releaseTag: string,
  packageVersion: string,
): {
  output: string;
  packageJson: { version: string };
  packageLock: { version: string; packages: { "": { version: string } } };
} {
  const directory = mkdtempSync(
    join(tmpdir(), "prek-autoupdate-prepare-release-"),
  );
  const packagePath = join(directory, "package.json");
  const lockPath = join(directory, "package-lock.json");
  const outputPath = join(directory, "output");
  writeFileSync(packagePath, JSON.stringify({ version: packageVersion }));
  writeFileSync(
    lockPath,
    JSON.stringify({
      version: packageVersion,
      packages: { "": { version: packageVersion } },
    }),
  );
  try {
    try {
      execFileSync(
        process.execPath,
        [resolve(".github/scripts/prepare-release.mjs")],
        {
          cwd: resolve("."),
          env: {
            ...process.env,
            GITHUB_OUTPUT: outputPath,
            PACKAGE_JSON_PATH: packagePath,
            PACKAGE_LOCK_PATH: lockPath,
            RELEASE_TAG: releaseTag,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (error) {
      const stderr = (error as { stderr?: Buffer | string }).stderr;
      throw new Error(
        stderr?.toString().trim() || "release preparation failed",
        {
          cause: error,
        },
      );
    }
    return {
      output: readFileSync(outputPath, "utf8"),
      packageJson: JSON.parse(readFileSync(packagePath, "utf8")),
      packageLock: JSON.parse(readFileSync(lockPath, "utf8")),
    };
  } finally {
    rmSync(directory, { recursive: true });
  }
}

function runPreparationWithGitFailure(failure: "diff" | "ls-files"): void {
  const directory = mkdtempSync(
    join(tmpdir(), "prek-autoupdate-prepare-script-"),
  );
  const gitPath = join(directory, "git");
  const nodePath = join(directory, "node");
  const npmPath = join(directory, "npm");
  writeFileSync(
    gitPath,
    `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
"status --porcelain"|"diff --check")
  exit 0
  ;;
"diff --name-only")
  if [[ "$FAILURE" == "diff" ]]; then
    echo "simulated git diff failure" >&2
    exit 23
  fi
  exit 0
  ;;
"ls-files --others --exclude-standard")
  if [[ "$FAILURE" == "ls-files" ]]; then
    echo "simulated git ls-files failure" >&2
    exit 24
  fi
  exit 0
  ;;
*)
  echo "unexpected git call: $*" >&2
  exit 2
  ;;
esac
`,
  );
  writeFileSync(nodePath, "#!/usr/bin/env bash\nexit 0\n");
  writeFileSync(npmPath, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(gitPath, 0o755);
  chmodSync(nodePath, 0o755);
  chmodSync(npmPath, 0o755);
  try {
    try {
      execFileSync("bash", [resolve(".github/scripts/prepare-release.sh")], {
        cwd: directory,
        env: {
          ...process.env,
          FAILURE: failure,
          PATH: `${directory}:${process.env.PATH}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const stderr = (error as { stderr?: Buffer | string }).stderr;
      throw new Error(
        stderr?.toString().trim() || "release preparation failed",
        {
          cause: error,
        },
      );
    }
  } finally {
    rmSync(directory, { recursive: true });
  }
}

function runReleaseUpdate(
  releaseTag: string,
  targetSha: string,
  tags: Array<{ name: string; commit: { sha: string } }>,
  releases: Array<{
    tag_name: string;
    draft: boolean;
    prerelease: boolean;
    published_at: string | null;
  }>,
  failure:
    | "none"
    | "release-tag-move"
    | "create-race"
    | "major-ref-read"
    | "major-ref-malformed"
    | "major-peel-read"
    | "major-peel-malformed" = "none",
  directRefOid?: string,
  pointRefOid = targetSha,
  pointTagDepth = 0,
  movingTagDepth = directRefOid === undefined ? 0 : 1,
): string {
  const directory = mkdtempSync(
    join(tmpdir(), "prek-autoupdate-release-write-"),
  );
  const ghPath = join(directory, "gh");
  const sleepPath = join(directory, "sleep");
  const callsPath = join(directory, "calls");
  const releaseMatch =
    /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(releaseTag);
  if (!releaseMatch) {
    throw new Error("release update fixture requires a valid release tag");
  }
  const majorTag = `v${releaseMatch[1]}`;
  const movingTagCommitSha =
    tags.find((tag) => tag.name === majorTag)?.commit.sha ?? "";
  const tagChain = (
    firstOid: string,
    depth: number,
    finalOid: string,
    namespace: string,
  ) => {
    const tagOids = Array.from({ length: depth }, (_, index) =>
      index === 0
        ? firstOid
        : `${namespace}${(index + 1).toString(16).padStart(39, "0")}`,
    );
    return tagOids.map((oid, index) => ({
      oid,
      nextOid: tagOids[index + 1] ?? finalOid,
      nextType: index + 1 < tagOids.length ? "tag" : "commit",
    }));
  };
  const pointTagOid = "e".repeat(40);
  const observedDirectRefOid = directRefOid ?? movingTagCommitSha;
  const pointChain = tagChain(pointTagOid, pointTagDepth, pointRefOid, "1");
  const movingChain = tagChain(
    observedDirectRefOid,
    movingTagDepth,
    movingTagCommitSha,
    "2",
  );
  const pointTagResponses = pointChain
    .map(
      ({ oid, nextOid, nextType }) =>
        `elif [[ "$*" == "api repos/$GITHUB_REPOSITORY/git/tags/${oid} --jq .object | [.sha, .type] | @tsv" ]]; then\n  printf '%s\\t%s\\n' '${nextOid}' '${nextType}'`,
    )
    .join("\n");
  const movingTagResponses = movingChain
    .map(
      ({ oid, nextOid, nextType }) =>
        `elif [[ "$*" == "api repos/$GITHUB_REPOSITORY/git/tags/${oid} --jq .object | [.sha, .type] | @tsv" ]]; then\n  [[ "$FAILURE" != "major-peel-read" ]] || exit 32\n  if [[ "$FAILURE" == "major-peel-malformed" ]]; then printf '%s\\n' 'incomplete'; exit 0; fi\n  printf '%s\\t%s\\n' '${nextOid}' '${nextType}'`,
    )
    .join("\n");
  writeFileSync(
    ghPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$CALLS_PATH"
if [[ "$*" == *"tags?per_page=100"* ]]; then
  printf '%s' "$TAGS_JSON"
elif [[ "$*" == *"releases?per_page=100"* ]]; then
  printf '%s' "$RELEASES_JSON"
elif [[ "$*" == "api repos/$GITHUB_REPOSITORY/git/ref/tags/$RELEASE_TAG --jq .object | [.sha, .type] | @tsv" ]]; then
  printf '%s\t%s\n' "$POINT_DIRECT_REF_OID" "$POINT_DIRECT_REF_TYPE"
elif [[ "$*" == "api repos/$GITHUB_REPOSITORY/git/ref/tags/$MAJOR_TAG --jq .object | [.sha, .type] | @tsv" ]]; then
  [[ "$FAILURE" != "major-ref-read" ]] || exit 31
  if [[ "$FAILURE" == "major-ref-malformed" ]]; then printf '%s\n' 'not-an-object'; exit 0; fi
  printf '%s\t%s\n' "$DIRECT_REF_OID" "$DIRECT_REF_TYPE"
${pointTagResponses}
${movingTagResponses}
elif [[ "$*" == "api repos/$GITHUB_REPOSITORY --jq .node_id" ]]; then
  printf '%s\n' 'R_repo_node'
elif [[ "$*" == api\\ graphql* ]]; then
  [[ "$FAILURE" != "release-tag-move" && "$FAILURE" != "create-race" ]] || exit 1
  printf '%s\n' '{"data":{"updateRefs":{"clientMutationId":null}}}'
else
  printf 'unexpected gh call: %s\n' "$*" >&2
  exit 2
fi
`,
  );
  chmodSync(ghPath, 0o755);
  writeFileSync(sleepPath, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(sleepPath, 0o755);
  try {
    try {
      execFileSync("bash", [resolve(".github/scripts/update-major-tag.sh")], {
        cwd: resolve("."),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          CALLS_PATH: callsPath,
          TAGS_JSON: JSON.stringify([tags]),
          RELEASES_JSON: JSON.stringify([releases]),
          DIRECT_REF_OID: observedDirectRefOid,
          DIRECT_REF_TYPE: directRefOid === undefined ? "commit" : "tag",
          MOVING_TAG_COMMIT_SHA: movingTagCommitSha,
          MAJOR_TAG: majorTag,
          POINT_DIRECT_REF_OID: pointTagDepth === 0 ? pointRefOid : pointTagOid,
          POINT_DIRECT_REF_TYPE: pointTagDepth === 0 ? "commit" : "tag",
          POINT_REF_OID: pointRefOid,
          FAILURE: failure,
          GITHUB_REPOSITORY: "owner/repository",
          GITHUB_WORKSPACE: resolve("."),
          RELEASE_TAG: releaseTag,
          TARGET_SHA: targetSha,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const stderr = (error as { stderr?: Buffer | string }).stderr;
      throw new Error(stderr?.toString().trim() || "release update failed", {
        cause: error,
      });
    }
    return readFileSync(callsPath, "utf8");
  } finally {
    rmSync(directory, { recursive: true });
  }
}

describe("release workflow", () => {
  it("requires a release tag when manually dispatched", () => {
    const releaseWorkflow = workflow();

    expect(Object.keys(releaseWorkflow.on)).toEqual(["workflow_dispatch"]);
    expect(releaseWorkflow.on.workflow_dispatch.inputs.tag).toMatchObject({
      required: true,
      type: "string",
    });
    expect(
      releaseWorkflow.on.workflow_dispatch.inputs.prerelease,
    ).toMatchObject({
      default: false,
      required: true,
      type: "boolean",
    });
  });

  it.each(["prepare", "finalize", "publish", "update-major"] as const)(
    "passes the dispatched tag to the %s job",
    (jobName) => {
      expect(
        workflow().jobs[jobName].steps.some(
          (step) => step.env?.RELEASE_TAG === "${{ inputs.tag }}",
        ),
      ).toBe(true);
    },
  );

  it("keeps prereleases away from the stable moving tag", () => {
    const releaseWorkflow = workflow();

    for (const jobName of ["prepare", "publish"] as const) {
      expect(
        releaseWorkflow.jobs[jobName].steps.some(
          (step) => step.env?.IS_PRERELEASE === "${{ inputs.prerelease }}",
        ),
      ).toBe(true);
    }
    expect(releaseWorkflow.jobs["update-major"].if).toBe(
      "inputs.prerelease == false",
    );
  });

  it.each([
    ["diff", "Unable to collect changed release paths"],
    ["ls-files", "Unable to collect untracked release paths"],
  ] as const)(
    "fails closed when git %s path collection fails",
    (failure, message) => {
      expect(() => runPreparationWithGitFailure(failure)).toThrow(message);
    },
  );

  it("updates package metadata to the published release version", () => {
    const prepared = prepareRelease("v2.0.3", "2.0.2");

    expect(prepared.output).toMatch(
      /^major-tag=v2\nsource-sha=[0-9a-f]{40}\n$/,
    );
    expect(prepared.packageJson.version).toBe("2.0.3");
    expect(prepared.packageLock.version).toBe("2.0.3");
    expect(prepared.packageLock.packages[""].version).toBe("2.0.3");
    expect(() => prepareRelease("v2.0.1", "2.0.2")).toThrow(/downgrade/u);
    expect(() => prepareRelease("v2", "2.0.2")).toThrow(
      /vMAJOR\.MINOR\.PATCH/u,
    );
  });

  it("updates package metadata to a valid prerelease version", () => {
    const prepared = prepareRelease("v2.1.0-beta.2", "2.1.0-beta.1");

    expect(prepared.output).toMatch(
      /^major-tag=v2\nsource-sha=[0-9a-f]{40}\n$/,
    );
    expect(prepared.packageJson.version).toBe("2.1.0-beta.2");
    expect(prepared.packageLock.version).toBe("2.1.0-beta.2");
    expect(prepared.packageLock.packages[""].version).toBe("2.1.0-beta.2");
    expect(() => prepareRelease("v2.1.0-beta.1", "2.1.0-beta.2")).toThrow(
      /downgrade/u,
    );
    expect(() => prepareRelease("v2.1.0-beta.01", "2.0.4")).toThrow(
      /vMAJOR\.MINOR\.PATCH/u,
    );
  });

  it("provisions prek before preparing release files", () => {
    const steps = workflow().jobs.prepare.steps;
    const setupIndex = steps.findIndex((step) =>
      step.uses?.startsWith("j178/prek-action@"),
    );
    const preparationIndex = steps.findIndex((step) => step.id === "release");

    expect(setupIndex).toBeGreaterThanOrEqual(0);
    expect(steps[setupIndex]?.with?.["install-only"]).toBe(true);
    expect(preparationIndex).toBeGreaterThan(setupIndex);
  });

  it("keeps release credentials scoped to write-capable jobs", () => {
    const releaseWorkflow = workflow();
    const checkouts = Object.values(releaseWorkflow.jobs).flatMap((job) =>
      job.steps.filter((step) => step.uses?.startsWith("actions/checkout@")),
    );

    expect(releaseWorkflow.permissions).toEqual({ contents: "read" });
    expect({
      ...releaseWorkflow.permissions,
      ...releaseWorkflow.jobs.prepare.permissions,
    }).toEqual({ contents: "read" });
    expect(releaseWorkflow.jobs.finalize.permissions).toEqual({
      actions: "read",
      contents: "write",
    });
    expect(releaseWorkflow.jobs["update-major"].permissions).toEqual({
      contents: "write",
    });
    const finalizeStep = releaseWorkflow.jobs.finalize.steps.find(
      (step) => step.id === "release",
    );
    expect(finalizeStep?.env?.GH_TOKEN).toBe("${{ github.token }}");
    expect(checkouts.length).toBeGreaterThan(0);
    for (const checkout of checkouts) {
      expect(checkout.with?.["persist-credentials"]).toBe(false);
    }
  });

  it("keeps moving major tags monotonic across releases and reruns", () => {
    const oldSha = "1".repeat(40);
    const targetSha = "2".repeat(40);
    const newerSha = "3".repeat(40);

    expect(
      decideRelease("v1.10.0", targetSha, [
        { name: "v1.9.9", commit: { sha: oldSha } },
        { name: "v1.10.0", commit: { sha: targetSha } },
      ]),
    ).toBe(`create\t${targetSha}`);
    expect(
      decideRelease("v1.10.0", targetSha, [
        { name: "v1", commit: { sha: oldSha } },
        { name: "v1.9.9", commit: { sha: oldSha } },
        { name: "v1.10.0", commit: { sha: targetSha } },
      ]),
    ).toBe(`update\t${targetSha}\t${oldSha}`);
    expect(
      decideRelease("v1.10.12", targetSha, [
        { name: "v1", commit: { sha: oldSha } },
        { name: "v1.10.9", commit: { sha: oldSha } },
        { name: "v1.10.12", commit: { sha: targetSha } },
      ]),
    ).toBe(`update\t${targetSha}\t${oldSha}`);
    expect(
      decideRelease("v1.10.0", targetSha, [
        { name: "v1", commit: { sha: targetSha } },
        { name: "v1.10.0", commit: { sha: targetSha } },
      ]),
    ).toBe("noop\t");
    expect(
      decideRelease("v1.10.0", targetSha, [
        { name: "v1", commit: { sha: newerSha } },
        { name: "v1.10.0", commit: { sha: targetSha } },
        { name: "v1.11.0", commit: { sha: newerSha } },
      ]),
    ).toBe("skip\t");
  });

  it("promotes only the triggering release verified by the read-only job", () => {
    const oldSha = "1".repeat(40);
    const triggeringSha = "2".repeat(40);
    const unverifiedNewerSha = "3".repeat(40);
    const tags = [
      { name: "v1", commit: { sha: oldSha } },
      { name: "v1.9.9", commit: { sha: oldSha } },
      { name: "v1.10.0", commit: { sha: triggeringSha } },
      { name: "v1.11.0", commit: { sha: unverifiedNewerSha } },
    ];

    expect(decideRelease("v1.10.0", triggeringSha, tags)).toBe(
      `update\t${triggeringSha}\t${oldSha}`,
    );
  });

  it("allows a surviving verified pending job to advance after replacement", () => {
    const oldSha = "1".repeat(40);
    const runningSha = "2".repeat(40);
    const replacedPendingSha = "3".repeat(40);
    const survivingPendingSha = "4".repeat(40);
    const tagsBeforeRunningUpdate = [
      { name: "v1", commit: { sha: oldSha } },
      { name: "v1.9.9", commit: { sha: oldSha } },
      { name: "v1.10.0", commit: { sha: runningSha } },
      { name: "v1.11.0", commit: { sha: replacedPendingSha } },
      { name: "v1.12.0", commit: { sha: survivingPendingSha } },
    ];

    expect(decideRelease("v1.10.0", runningSha, tagsBeforeRunningUpdate)).toBe(
      `update\t${runningSha}\t${oldSha}`,
    );

    const tagsAfterRunningUpdate = tagsBeforeRunningUpdate.map((tag) =>
      tag.name === "v1" ? { ...tag, commit: { sha: runningSha } } : tag,
    );
    expect(
      decideRelease("v1.12.0", survivingPendingSha, tagsAfterRunningUpdate),
    ).toBe(`update\t${survivingPendingSha}\t${runningSha}`);
  });

  it("uses an annotated moving tag's direct ref OID in the exact CAS update", () => {
    const oldSha = "1".repeat(40);
    const targetSha = "2".repeat(40);
    const annotatedTagOid = "a".repeat(40);
    const releases = ["v1.9.9", "v1.10.0"].map((tagName) => ({
      tag_name: tagName,
      draft: false,
      prerelease: false,
      published_at: "2026-01-01T00:00:00Z",
    }));
    const calls = runReleaseUpdate(
      "v1.10.0",
      targetSha,
      [
        { name: "v1", commit: { sha: oldSha } },
        { name: "v1.9.9", commit: { sha: oldSha } },
        { name: "v1.10.0", commit: { sha: targetSha } },
      ],
      releases,
      "none",
      annotatedTagOid,
    );

    expect(calls).toContain(
      "api repos/owner/repository/git/ref/tags/v1.10.0 " +
        "--jq .object | [.sha, .type] | @tsv",
    );
    expect(calls).toContain(
      "api repos/owner/repository/git/ref/tags/v1 " +
        "--jq .object | [.sha, .type] | @tsv",
    );
    expect(calls).toContain(
      `api repos/owner/repository/git/tags/${annotatedTagOid} ` +
        "--jq .object | [.sha, .type] | @tsv",
    );
    expect(calls).toContain("api repos/owner/repository --jq .node_id");
    expect(calls).toContain("api graphql");
    expect(calls).toContain("-F repositoryId=R_repo_node");
    expect(calls).toContain(`-f releaseOid=${targetSha}`);
    expect(calls).toContain("beforeOid: $releaseOid");
    expect(calls).toContain("afterOid: $releaseOid");
    expect(calls).toContain(`-f majorBeforeOid=${annotatedTagOid}`);
    expect(calls).not.toContain(`-f majorBeforeOid=${oldSha}`);
    expect(calls).toContain(`-f majorAfterOid=${targetSha}`);
  });

  it("keeps multi-level point and moving tag peel chains distinct", () => {
    const oldSha = "1".repeat(40);
    const targetSha = "2".repeat(40);
    const releases = ["v1.9.9", "v1.10.0"].map((tagName) => ({
      tag_name: tagName,
      draft: false,
      prerelease: false,
      published_at: "2026-01-01T00:00:00Z",
    }));
    const calls = runReleaseUpdate(
      "v1.10.0",
      targetSha,
      [
        { name: "v1", commit: { sha: oldSha } },
        { name: "v1.9.9", commit: { sha: oldSha } },
        { name: "v1.10.0", commit: { sha: targetSha } },
      ],
      releases,
      "none",
      "a".repeat(40),
      targetSha,
      2,
      2,
    );

    const pointChainOid = `1${"2".padStart(39, "0")}`;
    const movingChainOid = `2${"2".padStart(39, "0")}`;
    expect(calls).toContain(`git/tags/${pointChainOid}`);
    expect(calls).toContain(`git/tags/${movingChainOid}`);
    expect(calls).toContain("api graphql");
  });

  it("verifies the exact finalized release ref before reading tag lists", () => {
    const targetSha = "2".repeat(40);
    const calls = runReleaseUpdate(
      "v1.10.0",
      targetSha,
      [{ name: "v1.10.0", commit: { sha: targetSha } }],
      [
        {
          tag_name: "v1.10.0",
          draft: false,
          prerelease: false,
          published_at: "2026-01-01T00:00:00Z",
        },
      ],
    );

    const exactRefCall = "git/ref/tags/v1.10.0";
    const tagListCall = "tags?per_page=100";
    expect(calls).toContain(exactRefCall);
    expect(calls).toContain(tagListCall);
    expect(calls.indexOf(exactRefCall)).toBeLessThan(
      calls.indexOf(tagListCall),
    );
  });

  it("accepts a stale paginated SHA after verifying the exact release ref", () => {
    const staleSha = "1".repeat(40);
    const targetSha = "2".repeat(40);
    const calls = runReleaseUpdate(
      "v1.10.0",
      targetSha,
      [{ name: "v1.10.0", commit: { sha: staleSha } }],
      [
        {
          tag_name: "v1.10.0",
          draft: false,
          prerelease: false,
          published_at: "2026-01-01T00:00:00Z",
        },
      ],
    );

    expect(calls).toContain("git/ref/tags/v1.10.0");
    expect(calls).toContain(`-f majorAfterOid=${targetSha}`);
  });

  it("fails closed when the exact finalized release ref does not match", () => {
    const targetSha = "2".repeat(40);

    expect(() =>
      runReleaseUpdate(
        "v1.10.0",
        targetSha,
        [{ name: "v1.10.0", commit: { sha: targetSha } }],
        [],
        "none",
        undefined,
        "3".repeat(40),
      ),
    ).toThrow(/does not match its exact finalized tag ref/u);
  });

  it("fails closed when finalized release tag peeling exceeds the safe limit", () => {
    const targetSha = "2".repeat(40);

    expect(() =>
      runReleaseUpdate(
        "v1.10.0",
        targetSha,
        [{ name: "v1.10.0", commit: { sha: targetSha } }],
        [],
        "none",
        undefined,
        targetSha,
        17,
      ),
    ).toThrow(/Annotated release tag exceeds maximum peel depth of 16/u);
  });

  it.each([
    ["major-ref-read", /Unable to read major tag ref v1 from GitHub/u],
    ["major-ref-malformed", /GitHub returned an invalid major tag ref v1/u],
    ["major-peel-read", /Unable to read annotated major tag object/u],
    [
      "major-peel-malformed",
      /GitHub returned an invalid annotated major tag object/u,
    ],
  ] as const)("fails closed with diagnostics for %s", (failure, message) => {
    const oldSha = "1".repeat(40);
    const targetSha = "2".repeat(40);
    const releases = ["v1.9.9", "v1.10.0"].map((tagName) => ({
      tag_name: tagName,
      draft: false,
      prerelease: false,
      published_at: "2026-01-01T00:00:00Z",
    }));

    expect(() =>
      runReleaseUpdate(
        "v1.10.0",
        targetSha,
        [
          { name: "v1", commit: { sha: oldSha } },
          { name: "v1.9.9", commit: { sha: oldSha } },
          { name: "v1.10.0", commit: { sha: targetSha } },
        ],
        releases,
        failure,
        "a".repeat(40),
      ),
    ).toThrow(message);
  });

  it("fails closed when moving major tag peeling exceeds the safe limit", () => {
    const oldSha = "1".repeat(40);
    const targetSha = "2".repeat(40);
    const releases = ["v1.9.9", "v1.10.0"].map((tagName) => ({
      tag_name: tagName,
      draft: false,
      prerelease: false,
      published_at: "2026-01-01T00:00:00Z",
    }));

    expect(() =>
      runReleaseUpdate(
        "v1.10.0",
        targetSha,
        [
          { name: "v1", commit: { sha: oldSha } },
          { name: "v1.9.9", commit: { sha: oldSha } },
          { name: "v1.10.0", commit: { sha: targetSha } },
        ],
        releases,
        "none",
        "a".repeat(40),
        targetSha,
        0,
        17,
      ),
    ).toThrow(/Annotated major tag exceeds maximum peel depth of 16/u);
  });

  it("atomically rejects release-tag movement before updating the major tag", () => {
    const oldSha = "1".repeat(40);
    const targetSha = "2".repeat(40);
    const releases = ["v1.9.9", "v1.10.0"].map((tagName) => ({
      tag_name: tagName,
      draft: false,
      prerelease: false,
      published_at: "2026-01-01T00:00:00Z",
    }));

    expect(() =>
      runReleaseUpdate(
        "v1.10.0",
        targetSha,
        [
          { name: "v1", commit: { sha: oldSha } },
          { name: "v1.9.9", commit: { sha: oldSha } },
          { name: "v1.10.0", commit: { sha: targetSha } },
        ],
        releases,
        "release-tag-move",
      ),
    ).toThrow();
  });

  it("uses absence CAS and rejects a competing major-tag creation", () => {
    const targetSha = "2".repeat(40);
    const releases = [
      {
        tag_name: "v1.10.0",
        draft: false,
        prerelease: false,
        published_at: "2026-01-01T00:00:00Z",
      },
    ];

    const calls = runReleaseUpdate(
      "v1.10.0",
      targetSha,
      [{ name: "v1.10.0", commit: { sha: targetSha } }],
      releases,
    );
    expect(calls).toContain(
      'beforeOid: "0000000000000000000000000000000000000000"',
    );
    expect(calls).toContain(`-f releaseOid=${targetSha}`);

    expect(() =>
      runReleaseUpdate(
        "v1.10.0",
        targetSha,
        [{ name: "v1.10.0", commit: { sha: targetSha } }],
        releases,
        "create-race",
      ),
    ).toThrow();
  });

  it("fails closed when moving-tag monotonicity cannot be proven", () => {
    const targetSha = "2".repeat(40);

    expect(() =>
      decideRelease("v2.10.12", targetSha, [
        { name: "v2", commit: { sha: "f".repeat(40) } },
        { name: "v2.10.12", commit: { sha: targetSha } },
      ]),
    ).toThrow(/known finalized stable release/);
  });

  it("ignores tags without a successfully published stable release", () => {
    const targetSha = "2".repeat(40);
    const futureSha = "3".repeat(40);
    const tags = [
      { name: "v1.10.0", commit: { sha: targetSha } },
      { name: "v1.11.0", commit: { sha: futureSha } },
      { name: "v1.12.0", commit: { sha: futureSha } },
      { name: "v1.13.0", commit: { sha: futureSha } },
    ];
    const releases = [
      {
        tag_name: "v1.10.0",
        draft: false,
        prerelease: false,
        published_at: "2026-01-01T00:00:00Z",
      },
      {
        tag_name: "v1.12.0",
        draft: true,
        prerelease: false,
        published_at: null,
      },
      {
        tag_name: "v1.13.0",
        draft: false,
        prerelease: true,
        published_at: "2026-01-02T00:00:00Z",
      },
    ];

    expect(decideRelease("v1.10.0", targetSha, tags, releases)).toBe(
      `create\t${targetSha}`,
    );
  });

  it("requires the triggering release and every eligible release to match a tag", () => {
    const targetSha = "2".repeat(40);
    const published = (tagName: string) => ({
      tag_name: tagName,
      draft: false,
      prerelease: false,
      published_at: "2026-01-01T00:00:00Z",
    });

    expect(() =>
      decideRelease(
        "v1.10.0",
        targetSha,
        [{ name: "v1.10.0", commit: { sha: targetSha } }],
        [
          {
            ...published("v1.10.0"),
            prerelease: true,
          },
        ],
      ),
    ).toThrow(/not a published stable release/);
    expect(() =>
      decideRelease(
        "v1.10.0",
        targetSha,
        [{ name: "v1.10.0", commit: { sha: targetSha } }],
        [published("v1.10.0"), published("v1.11.0")],
      ),
    ).toThrow(/has no matching tag/);
  });
});

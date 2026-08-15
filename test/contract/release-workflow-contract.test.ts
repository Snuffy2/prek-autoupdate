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
  readonly id?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
}

interface WorkflowJob {
  readonly concurrency?: Record<string, unknown>;
  readonly outputs?: Record<string, string>;
  readonly permissions?: Record<string, string>;
  readonly steps: WorkflowStep[];
}

interface Workflow {
  readonly concurrency: Record<string, unknown>;
  readonly permissions: Record<string, string>;
  readonly jobs: {
    readonly "prepare": WorkflowJob;
    readonly "finalize": WorkflowJob;
    readonly "update-major": WorkflowJob;
  };
}

const RELEASE_DECISION_SCRIPT = resolve(".github/scripts/decide-major-tag.mjs");

function workflow(): Workflow {
  return parse(
    readFileSync(".github/workflows/release.yml", "utf8"),
  ) as Workflow;
}

function releaseUpdateScript(releaseWorkflow: Workflow): string {
  const step = releaseWorkflow.jobs["update-major"].steps.find(
    (candidate: { run?: unknown }) =>
      typeof candidate.run === "string" &&
      candidate.run.includes(".github/scripts/update-major-tag.sh"),
  );
  expect(step, "release workflow is missing its update script").toBeDefined();
  return step?.run ?? "";
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

function runReleaseUpdate(
  releaseWorkflow: Workflow,
  releaseTag: string,
  targetSha: string,
  tags: Array<{ name: string; commit: { sha: string } }>,
  releases: Array<{
    tag_name: string;
    draft: boolean;
    prerelease: boolean;
    published_at: string | null;
  }>,
  failure: "none" | "external-move" | "create-race" = "none",
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
  const tagChain = (firstOid: string, depth: number, finalOid: string) => {
    const tagOids = Array.from({ length: depth }, (_, index) =>
      index === 0 ? firstOid : (index + 1).toString(16).padStart(40, "0"),
    );
    return tagOids.map((oid, index) => ({
      oid,
      nextOid: tagOids[index + 1] ?? finalOid,
      nextType: index + 1 < tagOids.length ? "tag" : "commit",
    }));
  };
  const pointTagOid = "e".repeat(40);
  const observedDirectRefOid = directRefOid ?? movingTagCommitSha;
  const pointChain = tagChain(pointTagOid, pointTagDepth, pointRefOid);
  const movingChain = tagChain(
    observedDirectRefOid,
    movingTagDepth,
    movingTagCommitSha,
  );
  const tagResponses = [...pointChain, ...movingChain]
    .map(
      ({ oid, nextOid, nextType }) =>
        `elif [[ "$*" == "api repos/$GITHUB_REPOSITORY/git/tags/${oid} --jq .object | [.sha, .type] | @tsv" ]]; then\n  printf '%s\\t%s\\n' '${nextOid}' '${nextType}'`,
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
  printf '%s\t%s\n' "$DIRECT_REF_OID" "$DIRECT_REF_TYPE"
${tagResponses}
elif [[ "$*" == "api repos/$GITHUB_REPOSITORY --jq .node_id" ]]; then
  printf '%s\n' 'R_repo_node'
elif [[ "$*" == api\\ graphql* ]]; then
  [[ "$FAILURE" != "external-move" ]] || exit 1
  printf '%s\n' '{"data":{"updateRefs":{"clientMutationId":null}}}'
elif [[ "$*" == api\\ --method\\ POST* ]]; then
  [[ "$FAILURE" != "create-race" ]] || exit 1
  printf '{"ref":"refs/tags/%s"}\n' "$MAJOR_TAG"
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
      execFileSync(
        "bash",
        ["-eo", "pipefail", "-c", releaseUpdateScript(releaseWorkflow)],
        {
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
            POINT_DIRECT_REF_OID:
              pointTagDepth === 0 ? pointRefOid : pointTagOid,
            POINT_DIRECT_REF_TYPE: pointTagDepth === 0 ? "commit" : "tag",
            POINT_REF_OID: pointRefOid,
            FAILURE: failure,
            GITHUB_REPOSITORY: "owner/repository",
            GITHUB_WORKSPACE: resolve("."),
            RELEASE_TAG: releaseTag,
            TARGET_SHA: targetSha,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
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
  it("keeps release workflow logic in dedicated scripts", () => {
    const releaseWorkflow = workflow();
    const preparation = releaseWorkflow.jobs.prepare.steps.find(
      (step: { id?: string }) => step.id === "release",
    );
    const finalization = releaseWorkflow.jobs.finalize.steps.find(
      (step: { id?: string }) => step.id === "release",
    );

    expect(preparation?.run).toBe(
      "bash tooling/.github/scripts/prepare-release.sh",
    );
    expect(finalization?.run).toBe(
      "node tooling/.github/scripts/finalize-release.mjs",
    );
    expect(releaseUpdateScript(releaseWorkflow)).toBe(
      "bash .github/scripts/update-major-tag.sh",
    );
    expect(readFileSync(".github/scripts/prepare-release.sh", "utf8")).toMatch(
      /^npm run test:coverage$/mu,
    );
    expect(JSON.stringify(releaseWorkflow)).not.toContain("node <<");
  });

  it("updates package metadata to the published release version", () => {
    const prepared = prepareRelease("v2.0.3", "2.0.2");

    expect(prepared.output).toMatch(
      /^major-tag=v2\nsource-sha=[0-9a-f]{40}\n$/,
    );
    expect(prepared.packageJson.version).toBe("2.0.3");
    expect(prepared.packageLock.version).toBe("2.0.3");
    expect(prepared.packageLock.packages[""].version).toBe("2.0.3");
    expect(() => prepareRelease("v2.0.1", "2.0.2")).toThrow(
      "Release v2.0.1 would downgrade package.json from 2.0.2",
    );
    expect(() => prepareRelease("v2", "2.0.2")).toThrow(
      "Release tag must have vMAJOR.MINOR.PATCH form",
    );
  });

  it("isolates release preparation from repository write credentials", () => {
    const releaseWorkflow = workflow();
    const prepareCheckouts = releaseWorkflow.jobs.prepare.steps.filter(
      (step: { uses?: string }) => step.uses?.startsWith("actions/checkout@"),
    );
    const finalCheckouts = releaseWorkflow.jobs.finalize.steps.filter(
      (step: { uses?: string }) => step.uses?.startsWith("actions/checkout@"),
    );
    const writeCheckout = releaseWorkflow.jobs["update-major"].steps.find(
      (step: { uses?: string }) => step.uses?.startsWith("actions/checkout@"),
    );

    expect(releaseWorkflow.permissions).toEqual({ contents: "read" });
    expect(prepareCheckouts).toHaveLength(2);
    expect(prepareCheckouts[0]?.with).toMatchObject({
      "ref": "${{ github.event.release.tag_name }}",
      "fetch-depth": 0,
      "persist-credentials": false,
    });
    expect(prepareCheckouts[0]?.with?.path).toBeUndefined();
    expect(prepareCheckouts[1]?.with).toMatchObject({
      "ref": "${{ github.workflow_sha }}",
      "path": "tooling",
      "sparse-checkout": ".github/scripts",
      "persist-credentials": false,
    });
    expect(releaseWorkflow.concurrency).toEqual({
      "group": "release-${{ github.repository }}",
      "cancel-in-progress": false,
    });
    expect(releaseWorkflow.jobs.finalize.permissions).toEqual({
      actions: "read",
      contents: "write",
    });
    expect(finalCheckouts).toHaveLength(2);
    expect(finalCheckouts[0]?.with).toMatchObject({
      "ref": "${{ github.workflow_sha }}",
      "path": "tooling",
      "persist-credentials": false,
    });
    expect(finalCheckouts[1]?.with).toMatchObject({
      "ref": "${{ needs.prepare.outputs.source-sha }}",
      "path": "release",
      "persist-credentials": false,
    });
    expect(JSON.stringify(releaseWorkflow.jobs.finalize)).not.toMatch(
      /npm ci|npm test/,
    );
    expect(releaseWorkflow.jobs["update-major"].permissions).toEqual({
      contents: "write",
    });
    expect(writeCheckout?.with).toMatchObject({
      "ref": "${{ github.workflow_sha }}",
      "sparse-checkout": ".github/scripts",
      "persist-credentials": false,
    });
    expect(JSON.stringify(releaseWorkflow.jobs["update-major"])).not.toMatch(
      /npm ci|npm test|packages\//,
    );
    expect(releaseWorkflow.jobs["update-major"].concurrency).toEqual({
      "group":
        "release-major-${{ github.repository }}-${{ needs.prepare.outputs.major-tag }}",
      "cancel-in-progress": false,
    });
    expect(releaseWorkflow.jobs.prepare.outputs?.["major-tag"]).toBe(
      "${{ steps.release.outputs.major-tag }}",
    );
    expect(releaseWorkflow.jobs.finalize.outputs?.["release-sha"]).toBe(
      "${{ steps.release.outputs.sha }}",
    );
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
    const releaseWorkflow = workflow();
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
      releaseWorkflow,
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
    expect(calls).toContain("-f name=refs/tags/v1");
    expect(calls).toContain(`-f beforeOid=${annotatedTagOid}`);
    expect(calls).not.toContain(`-f beforeOid=${oldSha}`);
    expect(calls).toContain(`-f afterOid=${targetSha}`);
    expect(calls).toContain("-F force=true");
  });

  it("verifies the exact immutable release ref before reading tag lists", () => {
    const releaseWorkflow = workflow();
    const targetSha = "2".repeat(40);
    const calls = runReleaseUpdate(
      releaseWorkflow,
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

    expect(calls.indexOf("git/ref/tags/v1.10.0")).toBeLessThan(
      calls.indexOf("tags?per_page=100"),
    );
  });

  it("fails closed when the exact immutable release ref does not match", () => {
    const releaseWorkflow = workflow();
    const targetSha = "2".repeat(40);

    expect(() =>
      runReleaseUpdate(
        releaseWorkflow,
        "v1.10.0",
        targetSha,
        [{ name: "v1.10.0", commit: { sha: targetSha } }],
        [],
        "none",
        undefined,
        "3".repeat(40),
      ),
    ).toThrow(
      "Verified release SHA does not match its exact immutable tag ref",
    );
  });

  it("fails closed when immutable release tag peeling exceeds the safe limit", () => {
    const releaseWorkflow = workflow();
    const targetSha = "2".repeat(40);

    expect(() =>
      runReleaseUpdate(
        releaseWorkflow,
        "v1.10.0",
        targetSha,
        [{ name: "v1.10.0", commit: { sha: targetSha } }],
        [],
        "none",
        undefined,
        targetSha,
        17,
      ),
    ).toThrow(
      "Verified release SHA does not match its exact immutable tag ref",
    );
  });

  it("fails closed when moving major tag peeling exceeds the safe limit", () => {
    const releaseWorkflow = workflow();
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
        releaseWorkflow,
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
    ).toThrow("v1 changed while its update was being prepared");
  });

  it("fails closed when the moving tag changes after observation", () => {
    const releaseWorkflow = workflow();
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
        releaseWorkflow,
        "v1.10.0",
        targetSha,
        [
          { name: "v1", commit: { sha: oldSha } },
          { name: "v1.9.9", commit: { sha: oldSha } },
          { name: "v1.10.0", commit: { sha: targetSha } },
        ],
        releases,
        "external-move",
      ),
    ).toThrow();
  });

  it("fails closed when another run wins an absent-tag creation race", () => {
    const releaseWorkflow = workflow();
    const targetSha = "2".repeat(40);
    const releases = [
      {
        tag_name: "v1.10.0",
        draft: false,
        prerelease: false,
        published_at: "2026-01-01T00:00:00Z",
      },
    ];

    expect(() =>
      runReleaseUpdate(
        releaseWorkflow,
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
    ).toThrow(/known immutable stable release/);
    expect(() =>
      decideRelease("v2.10.12", targetSha, [
        { name: "v2.10.12", commit: { sha: "e".repeat(40) } },
      ]),
    ).toThrow(/does not match its immutable tag/);
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

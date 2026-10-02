import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const RELEASE_DECISION_SCRIPT = resolve(".github/scripts/decide-major-tag.mjs");

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

type ReleaseUpdateAction = "create" | "noop" | "skip" | "update";
type ReleaseUpdateFailure =
  | "create-race"
  | "major-race"
  | "none"
  | "point-mismatch"
  | "release-tag-move"
  | "release-tag-move-at-push";

interface ReleaseUpdateResult {
  readonly error: Error | undefined;
  readonly initialMajorDirectOid: string | undefined;
  readonly initialMajorSha: string | undefined;
  readonly majorDirectOid: string | undefined;
  readonly majorSha: string | undefined;
  readonly newerSha: string;
  readonly output: string;
  readonly targetSha: string;
}

function runReleaseUpdate(
  action: ReleaseUpdateAction,
  failure: ReleaseUpdateFailure = "none",
  annotatedMajor = false,
  staleListedPointSha = false,
): ReleaseUpdateResult {
  const directory = mkdtempSync(
    join(tmpdir(), "prek-autoupdate-release-write-"),
  );
  const remote = join(directory, "remote.git");
  const workspace = join(directory, "workspace");
  const binDirectory = join(directory, "bin");
  const ghPath = join(binDirectory, "gh");
  const gitPath = join(binDirectory, "git");
  const pointReadsPath = join(directory, "point-reads");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const runGit = (arguments_: string[]): string =>
    execFileSync(realGit, arguments_, {
      cwd: workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const remoteOid = (ref: string): string | undefined => {
    try {
      return runGit(["--git-dir", remote, "rev-parse", "--verify", ref]);
    } catch {
      return undefined;
    }
  };
  try {
    mkdirSync(binDirectory);
    execFileSync(realGit, ["init", "--bare", remote], { stdio: "ignore" });
    execFileSync(realGit, ["init", "--initial-branch=main", workspace], {
      stdio: "ignore",
    });
    runGit(["config", "user.name", "Release test"]);
    runGit(["config", "user.email", "test@example.invalid"]);
    runGit(["remote", "add", "origin", remote]);
    const commit = (message: string): string => {
      writeFileSync(join(workspace, "version"), `${message}\n`);
      runGit(["add", "version"]);
      runGit(["commit", "-m", message]);
      return runGit(["rev-parse", "HEAD"]);
    };
    const oldSha = commit("old release");
    const targetSha = commit("target release");
    const newerSha = commit("newer release");
    const raceSha = commit("racing update");
    const pointSha = failure === "point-mismatch" ? raceSha : targetSha;

    runGit(["tag", "v1.9.9", oldSha]);
    runGit(["tag", "-a", "v1.10.0", "-m", "Release v1.10.0", pointSha]);
    if (action === "skip") {
      runGit(["tag", "-a", "v1.11.0", "-m", "Release v1.11.0", newerSha]);
    }
    if (action !== "create") {
      const majorSha =
        action === "skip" ? newerSha : action === "noop" ? targetSha : oldSha;
      runGit(
        annotatedMajor
          ? ["tag", "-a", "v1", "-m", "Moving v1", majorSha]
          : ["tag", "v1", majorSha],
      );
    }
    runGit(["push", "origin", "HEAD:refs/heads/main"]);
    runGit(["push", "origin", "refs/tags/v1.9.9", "refs/tags/v1.10.0"]);
    if (action === "skip") runGit(["push", "origin", "refs/tags/v1.11.0"]);
    if (action !== "create") runGit(["push", "origin", "refs/tags/v1"]);

    const initialMajorDirectOid = remoteOid("refs/tags/v1");
    const initialMajorSha =
      remoteOid("refs/tags/v1^{}") ?? initialMajorDirectOid;
    const listedPointSha = staleListedPointSha ? oldSha : targetSha;
    const tags = [
      ...(action === "create"
        ? []
        : [
            {
              name: "v1",
              commit: {
                sha:
                  action === "skip"
                    ? newerSha
                    : action === "noop"
                      ? targetSha
                      : oldSha,
              },
            },
          ]),
      { name: "v1.9.9", commit: { sha: oldSha } },
      { name: "v1.10.0", commit: { sha: listedPointSha } },
      ...(action === "skip"
        ? [{ name: "v1.11.0", commit: { sha: newerSha } }]
        : []),
    ];
    const releases = tags
      .filter((tag) => tag.name !== "v1")
      .map((tag) => ({
        tag_name: tag.name,
        draft: false,
        prerelease: false,
        published_at: "2026-01-01T00:00:00Z",
      }));
    writeFileSync(
      ghPath,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"tags?per_page=100"* ]]; then
  printf '%s' "$TAGS_JSON"
elif [[ "$*" == *"releases?per_page=100"* ]]; then
  printf '%s' "$RELEASES_JSON"
else
  printf 'unexpected gh call: %s\\n' "$*" >&2
  exit 2
fi
`,
    );
    chmodSync(ghPath, 0o755);
    writeFileSync(
      gitPath,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "ls-remote" && "$*" == *"refs/tags/$RELEASE_TAG"* ]]; then
  count=0
  [[ ! -f "$POINT_READS_PATH" ]] || read -r count < "$POINT_READS_PATH"
  ((count += 1))
  printf '%s\\n' "$count" > "$POINT_READS_PATH"
  if [[ "$FAILURE" == "release-tag-move" && "$count" -ge 2 ]]; then
    "$REAL_GIT" --git-dir="$REMOTE_PATH" update-ref "refs/tags/$RELEASE_TAG" "$RACE_SHA"
  fi
elif [[ "$1" == "push" ]]; then
  if [[ "$FAILURE" == "release-tag-move-at-push" ]]; then
    "$REAL_GIT" --git-dir="$REMOTE_PATH" update-ref "refs/tags/$RELEASE_TAG" "$RACE_SHA"
  fi
  if [[ "$FAILURE" == "major-race" || "$FAILURE" == "create-race" ]]; then
    "$REAL_GIT" --git-dir="$REMOTE_PATH" update-ref "refs/tags/$MAJOR_TAG" "$RACE_SHA"
  fi
fi
exec "$REAL_GIT" "$@"
`,
    );
    chmodSync(gitPath, 0o755);

    let output = "";
    let error: Error | undefined;
    try {
      output = execFileSync(
        "bash",
        [resolve(".github/scripts/update-major-tag.sh")],
        {
          cwd: workspace,
          encoding: "utf8",
          env: {
            ...process.env,
            FAILURE: failure,
            GITHUB_REPOSITORY: "owner/repository",
            MAJOR_TAG: "v1",
            PATH: `${binDirectory}:${process.env.PATH}`,
            POINT_READS_PATH: pointReadsPath,
            RACE_SHA: raceSha,
            REAL_GIT: realGit,
            RELEASES_JSON: JSON.stringify([releases]),
            RELEASE_TAG: "v1.10.0",
            REMOTE_PATH: remote,
            TAGS_JSON: JSON.stringify([tags]),
            TARGET_SHA: targetSha,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (caught) {
      const failureOutput = caught as {
        stderr?: Buffer | string;
        stdout?: Buffer | string;
      };
      error = new Error(
        failureOutput.stderr?.toString().trim() ||
          failureOutput.stdout?.toString().trim() ||
          "release update failed",
        { cause: caught },
      );
    }
    return {
      error,
      initialMajorDirectOid,
      initialMajorSha,
      majorDirectOid: remoteOid("refs/tags/v1"),
      majorSha: remoteOid("refs/tags/v1^{}") ?? remoteOid("refs/tags/v1"),
      newerSha,
      output,
      targetSha,
    };
  } finally {
    rmSync(directory, { recursive: true });
  }
}

describe("moving major release tag", () => {
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

  it.each([
    ["lightweight", false],
    ["annotated", true],
  ] as const)(
    "updates an existing %s moving tag through a real Git remote",
    (_kind, annotated) => {
      const result = runReleaseUpdate("update", "none", annotated);

      expect(result.error).toBeUndefined();
      expect(result.initialMajorSha).not.toBe(result.targetSha);
      expect(result.majorSha).toBe(result.targetSha);
      expect(result.majorDirectOid).toBe(result.targetSha);
    },
  );

  it("creates a missing moving tag through a real Git remote", () => {
    const result = runReleaseUpdate("create");

    expect(result.error).toBeUndefined();
    expect(result.initialMajorSha).toBeUndefined();
    expect(result.majorSha).toBe(result.targetSha);
  });

  it.each(["noop", "skip"] as const)(
    "leaves the moving tag unchanged for a %s decision",
    (action) => {
      const result = runReleaseUpdate(action);

      expect(result.error).toBeUndefined();
      expect(result.majorSha).toBe(result.initialMajorSha);
      if (action === "skip") expect(result.majorSha).toBe(result.newerSha);
    },
  );

  it("accepts a stale paginated SHA after verifying the exact remote tag", () => {
    const result = runReleaseUpdate("create", "none", false, true);

    expect(result.error).toBeUndefined();
    expect(result.majorSha).toBe(result.targetSha);
  });

  it("fails closed when the exact finalized release ref does not match", () => {
    const result = runReleaseUpdate("update", "point-mismatch");

    expect(result.error?.message).toMatch(
      /does not match its exact finalized tag ref/u,
    );
    expect(result.majorSha).toBe(result.initialMajorSha);
  });

  it.each([
    ["update", "major-race"],
    ["create", "create-race"],
  ] as const)(
    "rejects a competing %s through the real Git lease",
    (action, failure) => {
      const result = runReleaseUpdate(action, failure, action === "update");

      expect(result.error).toBeDefined();
      expect(result.majorSha).not.toBe(result.targetSha);
    },
  );

  it.each(["update", "create", "noop", "skip"] as const)(
    "rejects release-tag movement before completing a %s decision",
    (action) => {
      const result = runReleaseUpdate(action, "release-tag-move");

      expect(result.error?.message).toMatch(
        /changed while its update was being prepared/u,
      );
      expect(result.majorSha).toBe(result.initialMajorSha);
    },
  );

  it.each([
    ["update", true],
    ["create", false],
  ] as const)(
    "restores the moving tag when the release tag moves during a %s push",
    (action, annotated) => {
      const result = runReleaseUpdate(
        action,
        "release-tag-move-at-push",
        annotated,
      );

      expect(result.error?.message).toMatch(
        /changed while its update was being prepared/u,
      );
      expect(result.majorSha).toBe(result.initialMajorSha);
      expect(result.majorDirectOid).toBe(result.initialMajorDirectOid);
    },
  );

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

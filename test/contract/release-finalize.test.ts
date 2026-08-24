import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const SOURCE_SHA = "1".repeat(40);
const RELEASE_SHA = "2".repeat(40);
const RELEASE_FILES = ["dist/index.js", "package-lock.json", "package.json"];

function writeReleaseFiles(
  root: string,
  version: string,
  marker: string,
): void {
  for (const relativePath of RELEASE_FILES) {
    const path = join(root, relativePath);
    mkdirSync(resolve(path, ".."), { recursive: true });
    if (relativePath === "package.json") {
      writeFileSync(path, `${JSON.stringify({ version })}\n`);
    } else if (relativePath === "package-lock.json") {
      writeFileSync(
        path,
        `${JSON.stringify({ version, packages: { "": { version } } })}\n`,
      );
    } else {
      writeFileSync(path, marker);
    }
  }
}

interface FinalizerOptions {
  branchSha?: string;
  cachedDiffStatus?: number;
  changedPaths?: string[];
  noChanges?: boolean;
  releaseTag?: string;
  mutatePrepared?: (directory: string) => void;
  statusOutput?: string;
  tagCommitSha?: string;
  tagFilesMatch?: boolean;
  tagSha?: string;
  tagMissing?: boolean;
  tagParentSha?: string;
  tagSubject?: string;
}

function runFinalizer(options: FinalizerOptions = {}): {
  calls: string;
  output: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "prek-autoupdate-finalize-"));
  const releaseDirectory = join(directory, "release");
  const preparedDirectory = join(directory, "prepared");
  const binDirectory = join(directory, "bin");
  const callsPath = join(directory, "calls");
  const outputPath = join(directory, "output");
  const releaseTag = options.releaseTag ?? "v2.0.3";
  mkdirSync(binDirectory, { recursive: true });
  writeReleaseFiles(releaseDirectory, "2.0.2", "old");
  writeReleaseFiles(preparedDirectory, releaseTag.slice(1), "new");
  options.mutatePrepared?.(preparedDirectory);
  const gitPath = join(binDirectory, "git");
  writeFileSync(
    gitPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$CALLS_PATH"
case "$1" in
status)
  printf '%s' "$STATUS_OUTPUT"
  exit 0
  ;;
diff)
  if [[ "$2" == "--name-only" ]]; then
    printf '%s\n' "$CHANGED_PATHS"
    exit 0
  fi
  if [[ "$2" == "--cached" && "$3" == "--quiet" ]]; then
    [[ "$NO_CHANGES" == "true" ]] && exit 0
    exit "$CACHED_DIFF_STATUS"
  fi
  if [[ "$2" == "--quiet" ]]; then
    [[ "$TAG_FILES_MATCH" == "true" ]] && exit 0
    exit 1
  fi
  ;;
ls-remote)
  printf '%s\trefs/heads/main\n' "$BRANCH_SHA"
  if [[ "$TAG_MISSING" != "true" ]]; then
    printf '%s\trefs/tags/%s\n' "$TAG_SHA" "$RELEASE_TAG"
    printf '%s\trefs/tags/%s^{}\n' "$TAG_COMMIT_SHA" "$RELEASE_TAG"
  fi
  exit 0
  ;;
tag)
  if [[ "$2" == "-a" && "$3" == "$RELEASE_TAG" && "$4" == "-m" ]]; then
    printf 'annotated-tag target=%s\n' "$6" >> "$CALLS_PATH"
    exit 0
  fi
  exit 2
  ;;
add|config|commit|fetch)
  exit 0
  ;;
rev-list)
  printf '%s %s\n' "$TAG_COMMIT_SHA" "$TAG_PARENT_SHA"
  exit 0
  ;;
log)
  printf '%s\n' "$TAG_SUBJECT"
  exit 0
  ;;
rev-parse)
  printf '%s\n' "$RELEASE_SHA"
  exit 0
  ;;
push)
  expected_auth="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GH_TOKEN" | base64)"
  [[ "\${GIT_CONFIG_COUNT:-}" == "1" ]] || exit 2
  [[ "\${GIT_CONFIG_KEY_0:-}" == "http.extraheader" ]] || exit 2
  [[ "\${GIT_CONFIG_VALUE_0:-}" == "$expected_auth" ]] || exit 2
  printf 'push-env count=1 key=http.extraheader value-valid=true\n' >> "$CALLS_PATH"
  exit 0
  ;;
esac
printf 'unexpected git call: %s\n' "$*" >&2
exit 2
`,
  );
  chmodSync(gitPath, 0o755);
  try {
    try {
      execFileSync(
        process.execPath,
        [resolve(".github/scripts/finalize-release.mjs")],
        {
          cwd: resolve("."),
          env: {
            ...process.env,
            BRANCH_SHA: options.branchSha ?? SOURCE_SHA,
            CACHED_DIFF_STATUS: String(options.cachedDiffStatus ?? 1),
            CALLS_PATH: callsPath,
            CHANGED_PATHS: (options.changedPaths ?? RELEASE_FILES).join("\n"),
            DEFAULT_BRANCH: "main",
            GH_TOKEN: "token-sentinel",
            GITHUB_OUTPUT: outputPath,
            PATH: `${binDirectory}:${process.env.PATH}`,
            PREPARED_DIRECTORY: preparedDirectory,
            RELEASE_DIRECTORY: releaseDirectory,
            RELEASE_SHA,
            RELEASE_TAG: releaseTag,
            NO_CHANGES: String(options.noChanges ?? false),
            SOURCE_SHA,
            STATUS_OUTPUT: options.statusOutput ?? "",
            TAG_COMMIT_SHA: options.tagCommitSha ?? SOURCE_SHA,
            TAG_FILES_MATCH: String(options.tagFilesMatch ?? true),
            TAG_MISSING: String(options.tagMissing ?? true),
            TAG_PARENT_SHA: options.tagParentSha ?? SOURCE_SHA,
            TAG_SHA: options.tagSha ?? SOURCE_SHA,
            TAG_SUBJECT:
              options.tagSubject ??
              `Updating to version ${releaseTag} [skip ci]`,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (error) {
      const stderr = (error as { stderr?: Buffer | string }).stderr;
      throw new Error(
        stderr?.toString().trim() || "release finalization failed",
        {
          cause: error,
        },
      );
    }
    return {
      calls: readFileSync(callsPath, "utf8"),
      output: readFileSync(outputPath, "utf8"),
    };
  } finally {
    rmSync(directory, { recursive: true });
  }
}

describe("release finalization", () => {
  it("publishes only an annotated tag for the local release commit", () => {
    const result = runFinalizer();

    expect(result.output).toBe(`sha=${RELEASE_SHA}\n`);
    expect(result.calls).toContain(`annotated-tag target=${RELEASE_SHA}`);
    expect(result.calls).toContain("refs/tags/v2.0.3:refs/tags/v2.0.3");
    expect(result.calls).toContain("--force-with-lease=refs/tags/v2.0.3:");
    expect(result.calls).not.toContain("HEAD:refs/heads/main");
    expect(result.calls).not.toContain("token-sentinel");
    expect(result.calls).not.toContain(
      Buffer.from("x-access-token:token-sentinel").toString("base64"),
    );
    expect(result.calls).toContain(
      "push-env count=1 key=http.extraheader value-valid=true",
    );
  });

  it("resumes an existing annotated release tag after validation", () => {
    const tagSha = "3".repeat(40);
    const result = runFinalizer({
      tagCommitSha: RELEASE_SHA,
      tagMissing: false,
      tagSha,
    });

    expect(result.output).toBe(`sha=${RELEASE_SHA}\n`);
    expect(result.calls).not.toContain("push ");
  });

  it("accepts a semantic prerelease tag", () => {
    const result = runFinalizer({
      releaseTag: "v2.1.0-beta.1",
      tagMissing: true,
    });

    expect(result.output).toBe(`sha=${RELEASE_SHA}\n`);
    expect(result.calls).toContain(`annotated-tag target=${RELEASE_SHA}`);
  });

  it("fails if the default branch advances during preparation", () => {
    expect(() => runFinalizer({ branchSha: "3".repeat(40) })).toThrow(
      "Default branch advanced during preparation",
    );
  });

  it("rejects an existing release tag with the wrong parent", () => {
    expect(() =>
      runFinalizer({
        tagCommitSha: RELEASE_SHA,
        tagMissing: false,
        tagParentSha: "4".repeat(40),
        tagSha: "3".repeat(40),
      }),
    ).toThrow(/existing release tag/iu);
  });

  it("rejects an existing lightweight release tag", () => {
    expect(() =>
      runFinalizer({
        tagCommitSha: RELEASE_SHA,
        tagMissing: false,
        tagSha: RELEASE_SHA,
      }),
    ).toThrow(/existing release tag/iu);
  });

  it("rejects an existing release tag with different release files", () => {
    expect(() =>
      runFinalizer({
        tagCommitSha: RELEASE_SHA,
        tagFilesMatch: false,
        tagMissing: false,
        tagSha: "3".repeat(40),
      }),
    ).toThrow(/existing release tag/iu);
  });

  it("rejects a dirty release checkout", () => {
    expect(() => runFinalizer({ statusOutput: " M package.json\n" })).toThrow(
      "Release checkout must start clean",
    );
  });

  it("tags the source SHA when prepared files are unchanged", () => {
    const result = runFinalizer({ noChanges: true });

    expect(result.output).toBe(`sha=${SOURCE_SHA}\n`);
    expect(result.calls).toContain(`annotated-tag target=${SOURCE_SHA}`);
    expect(result.calls).not.toContain("commit -m");
  });

  it("does not mask an unexpected cached diff failure", () => {
    expect(() => runFinalizer({ cachedDiffStatus: 2 })).toThrow(
      "Command failed: git diff --cached --quiet",
    );
  });

  it("rejects a prepared symlink", () => {
    expect(() =>
      runFinalizer({
        mutatePrepared: (directory) => {
          const path = join(directory, "package.json");
          rmSync(path);
          symlinkSync("package-lock.json", path);
        },
      }),
    ).toThrow("Prepared release path is not a regular file: package.json");
  });

  it("rejects a prepared file larger than 10 MiB", () => {
    expect(() =>
      runFinalizer({
        mutatePrepared: (directory) => {
          truncateSync(join(directory, "dist/index.js"), 10 * 1024 * 1024 + 1);
        },
      }),
    ).toThrow("Prepared release path is too large: dist/index.js");
  });

  it("rejects an unexpected changed path", () => {
    expect(() =>
      runFinalizer({ changedPaths: [...RELEASE_FILES, "unexpected.txt"] }),
    ).toThrow("Unexpected prepared path: unexpected.txt");
  });

  it("rejects package and lock versions that disagree with the release tag", () => {
    expect(() =>
      runFinalizer({
        mutatePrepared: (directory) => {
          writeFileSync(
            join(directory, "package-lock.json"),
            `${JSON.stringify({ version: "2.0.2", packages: { "": { version: "2.0.2" } } })}\n`,
          );
        },
      }),
    ).toThrow("Prepared package versions do not match the release tag");
  });
});

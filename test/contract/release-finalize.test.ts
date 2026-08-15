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
  mutatePrepared?: (directory: string) => void;
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
  mkdirSync(binDirectory, { recursive: true });
  writeReleaseFiles(releaseDirectory, "2.0.2", "old");
  writeReleaseFiles(preparedDirectory, "2.0.3", "new");
  options.mutatePrepared?.(preparedDirectory);
  const gitPath = join(binDirectory, "git");
  writeFileSync(
    gitPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$CALLS_PATH"
case "$1" in
status)
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
  ;;
ls-remote)
  printf '%s\trefs/heads/main\n' "$BRANCH_SHA"
  printf '%s\trefs/tags/v2.0.3\n' "$SOURCE_SHA"
  exit 0
  ;;
add|config|commit)
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
            RELEASE_TAG: "v2.0.3",
            NO_CHANGES: String(options.noChanges ?? false),
            SOURCE_SHA,
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
  it("atomically rewrites the default branch and published release tag", () => {
    const result = runFinalizer();

    expect(result.output).toBe(`sha=${RELEASE_SHA}\n`);
    expect(result.calls).toContain(
      "commit -m Updating to version v2.0.3 [skip ci]",
    );
    expect(result.calls).toContain("push --atomic");
    expect(result.calls).toContain(
      `--force-with-lease=refs/heads/main:${SOURCE_SHA}`,
    );
    expect(result.calls).toContain(
      `--force-with-lease=refs/tags/v2.0.3:${SOURCE_SHA}`,
    );
    expect(result.calls).toContain("HEAD:refs/heads/main");
    expect(result.calls).toContain("+HEAD:refs/tags/v2.0.3");
    expect(result.calls).not.toContain("token-sentinel");
    expect(result.calls).not.toContain(
      Buffer.from("x-access-token:token-sentinel").toString("base64"),
    );
    expect(result.calls).toContain(
      "push-env count=1 key=http.extraheader value-valid=true",
    );
  });

  it("fails if the default branch advances during preparation", () => {
    expect(() => runFinalizer({ branchSha: "3".repeat(40) })).toThrow(
      "Default branch or release tag advanced during preparation",
    );
  });

  it("writes the source SHA without pushing when prepared files are unchanged", () => {
    const result = runFinalizer({ noChanges: true });

    expect(result.output).toBe(`sha=${SOURCE_SHA}\n`);
    expect(result.calls).not.toContain("push --atomic");
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

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

function publishRelease(
  releaseTag: string,
  isPrerelease: boolean,
  existingState: "missing" | "draft" | "published" = "missing",
  existingPrerelease = isPrerelease,
): string {
  const directory = mkdtempSync(join(tmpdir(), "prek-autoupdate-publish-"));
  const ghPath = join(directory, "gh");
  const callsPath = join(directory, "calls");
  writeFileSync(
    ghPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$CALLS_PATH"
if [[ "$*" == "release view"* ]]; then
  case "$EXISTING_STATE" in
  missing)
    echo "release not found" >&2
    exit 1
    ;;
  draft)
    printf 'true\t%s\n' "$EXISTING_PRERELEASE"
    ;;
  published)
    printf 'false\t%s\n' "$EXISTING_PRERELEASE"
    ;;
  esac
  exit 0
fi
if [[ "$*" == "release create"* || "$*" == "release edit"* ]]; then
  exit 0
fi
echo "unexpected gh call: $*" >&2
exit 2
`,
  );
  chmodSync(ghPath, 0o755);
  try {
    try {
      execFileSync("bash", [resolve(".github/scripts/publish-release.sh")], {
        cwd: resolve("."),
        env: {
          ...process.env,
          CALLS_PATH: callsPath,
          EXISTING_PRERELEASE: String(existingPrerelease),
          EXISTING_STATE: existingState,
          IS_PRERELEASE: String(isPrerelease),
          PATH: `${directory}:${process.env.PATH}`,
          RELEASE_TAG: releaseTag,
          RUNNER_TEMP: directory,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const stderr = (error as { stderr?: Buffer | string }).stderr;
      throw new Error(stderr?.toString().trim() || "release publish failed", {
        cause: error,
      });
    }
    return readFileSync(callsPath, "utf8");
  } finally {
    rmSync(directory, { recursive: true });
  }
}

describe("release publication", () => {
  it("publishes a stable release without the prerelease flag", () => {
    const calls = publishRelease("v2.1.0", false);
    const createCall = calls
      .split("\n")
      .find((call) => call.startsWith("release create "));

    expect(createCall).toContain("release create v2.1.0");
    expect(createCall).toContain("--verify-tag");
    expect(createCall).not.toContain("--prerelease");
  });

  it("publishes a prerelease with the prerelease flag", () => {
    const calls = publishRelease("v2.1.0-beta.1", true);
    const createCall = calls
      .split("\n")
      .find((call) => call.startsWith("release create "));

    expect(createCall).toContain("release create v2.1.0-beta.1");
    expect(createCall).toContain("--verify-tag");
    expect(createCall).toContain("--prerelease");
  });

  it("rejects an existing release with a different prerelease state", () => {
    expect(() => publishRelease("v2.1.0-beta.1", true, "draft", false)).toThrow(
      /prerelease state does not match/u,
    );
  });
});

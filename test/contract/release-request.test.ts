import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

interface RequestOptions {
  readonly defaultBranch?: string;
  readonly lookup: "error" | "missing";
  readonly releaseRef?: string;
}

function validateReleaseRequest(options: RequestOptions): void {
  const directory = mkdtempSync(join(tmpdir(), "prek-autoupdate-request-"));
  const ghPath = join(directory, "gh");
  writeFileSync(
    ghPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$LOOKUP" == "missing" ]]; then
  echo "HTTP 404: release not found" >&2
else
  echo "authentication failed" >&2
fi
exit 1
`,
  );
  chmodSync(ghPath, 0o755);
  try {
    try {
      execFileSync(
        "bash",
        [resolve(".github/scripts/validate-release-request.sh")],
        {
          cwd: resolve("."),
          env: {
            ...process.env,
            DEFAULT_BRANCH: options.defaultBranch ?? "main",
            IS_PRERELEASE: "false",
            LOOKUP: options.lookup,
            PATH: `${directory}:${process.env.PATH}`,
            RELEASE_REF: options.releaseRef ?? "main",
            RELEASE_TAG: "v2.1.0",
            RUNNER_TEMP: directory,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (error) {
      const stderr = (error as { stderr?: Buffer | string }).stderr;
      throw new Error(
        stderr?.toString().trim() || "release request validation failed",
        { cause: error },
      );
    }
  } finally {
    rmSync(directory, { recursive: true });
  }
}

describe("release request validation", () => {
  it("rejects a dispatch outside the default branch", () => {
    expect(() =>
      validateReleaseRequest({ lookup: "missing", releaseRef: "feature" }),
    ).toThrow(/must be dispatched from main, not feature/u);
  });

  it("accepts a missing release", () => {
    expect(() => validateReleaseRequest({ lookup: "missing" })).not.toThrow();
  });

  it("fails closed when the release lookup fails unexpectedly", () => {
    expect(() => validateReleaseRequest({ lookup: "error" })).toThrow(
      /authentication failed/u,
    );
  });
});

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

const SHA = "a".repeat(40);
const SCRIPT = resolve(".github/scripts/verify-release-checks.mjs");

function runVerifier(
  mode = "success",
  requiredChecks = ["ci.yml::Node CI"],
): string {
  const directory = mkdtempSync(join(tmpdir(), "prek-release-checks-"));
  const ghPath = join(directory, "gh");
  const callsPath = join(directory, "calls");
  writeFileSync(
    ghPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$CALLS_PATH"
case "$*" in
*'/dispatches'*)
  if [[ " $* " != *" -F return_run_details=true "* ]]; then
    echo 'For properties/return_run_details, "true" is not a boolean. (HTTP 422)' >&2
    exit 1
  fi
  if [[ "$MODE" == invalid-run-id ]]; then
    payload='{"workflow_run_id":true}'
  elif [[ "$*" == *'/later.yml/'* ]]; then
    payload='{"workflow_run_id":43}'
  else
    payload='{"workflow_run_id":42}'
  fi
  printf 'HTTP/2.0 200 OK\ncontent-type: application/json\n\n%s\n' "$payload"
  ;;
*'/actions/workflows/ci.yml')
  printf '%s\n' '{"id":7}'
  ;;
*'/actions/workflows/later.yml')
  printf '%s\n' '{"id":8}'
  ;;
*'/actions/runs/42/jobs?per_page=100')
  if [[ "$MODE" == duplicate-job ]]; then
    printf '%s\n' '{"total_count":2,"jobs":[{"name":"Node CI","conclusion":"success"},{"name":"Node CI","conclusion":"success"}]}'
  else
    printf '%s\n' '{"total_count":1,"jobs":[{"name":"Node CI","conclusion":"success"}]}'
  fi
  ;;
*'/statuses/'*)
  context=''
  for argument in "$@"; do
    [[ "$argument" != context=* ]] || context="\${argument#context=}"
  done
  printf '{"state":"success","context":"%s"}\n' "$context"
  ;;
*'/actions/runs/42')
  head_sha="$SHA"
  [[ "$MODE" != wrong-sha ]] || head_sha="$(printf 'b%.0s' {1..40})"
  printf '{"id":42,"workflow_id":7,"event":"workflow_dispatch","head_branch":"release-validation/v2.1.0-10-1","head_sha":"%s","status":"completed","conclusion":"success","check_suite_id":99}\n' "$head_sha"
  ;;
*'/actions/runs/43')
  printf '{"id":43,"workflow_id":8,"event":"workflow_dispatch","head_branch":"release-validation/v2.1.0-10-1","head_sha":"%s","status":"completed","conclusion":"failure","check_suite_id":100}\n' "$SHA"
  ;;
*'/check-suites/99')
  printf '{"head_sha":"%s","app":{"slug":"github-actions"}}\n' "$SHA"
  ;;
*)
  echo "unexpected gh call: $*" >&2
  exit 2
  ;;
esac
`,
  );
  chmodSync(ghPath, 0o755);
  try {
    try {
      execFileSync(
        process.execPath,
        [
          SCRIPT,
          "--repository",
          "owner/repository",
          "--ref",
          "release-validation/v2.1.0-10-1",
          "--sha",
          SHA,
          ...requiredChecks.flatMap((check) => ["--required-check", check]),
          "--timeout-seconds",
          "1",
        ],
        {
          env: {
            ...process.env,
            CALLS_PATH: callsPath,
            MODE: mode,
            PATH: `${directory}:${process.env.PATH}`,
            SHA,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (error) {
      const stderr = (error as { stderr?: Buffer | string }).stderr;
      throw Object.assign(
        new Error(stderr?.toString().trim() || "release verification failed", {
          cause: error,
        }),
        { calls: readFileSync(callsPath, "utf8") },
      );
    }
    return readFileSync(callsPath, "utf8");
  } finally {
    rmSync(directory, { recursive: true });
  }
}

describe("release check verification", () => {
  it("dispatches the exact candidate and verifies the authoritative run", () => {
    const calls = runVerifier();

    expect(calls).toContain("-F return_run_details=true");
    expect(calls).toContain("ref=release-validation/v2.1.0-10-1");
    expect(calls).toContain(`inputs[expected_sha]=${SHA}`);
    expect(calls).toContain("actions/runs/42/jobs?per_page=100");
    expect(calls).not.toContain("actions/runs?branch=");
    expect(calls).toContain(`repos/owner/repository/statuses/${SHA}`);
    expect(calls).toContain("state=success");
    expect(calls).toContain("context=Node CI");
    expect(calls).toContain(
      "target_url=https://github.com/owner/repository/actions/runs/42",
    );
  });

  it.each([
    ["invalid-run-id", /valid workflow_run_id/u],
    ["wrong-sha", /does not match the dispatched identity/u],
    ["duplicate-job", /duplicate=\["Node CI"\]/u],
  ])("fails closed for %s", (mode, message) => {
    expect(() => runVerifier(mode)).toThrow(message);
  });

  it("publishes no status until every workflow is verified", () => {
    let failure: (Error & { calls?: string }) | undefined;
    try {
      runVerifier("later-workflow-fails", [
        "ci.yml::Node CI",
        "later.yml::later",
      ]);
    } catch (error) {
      failure = error as Error & { calls?: string };
    }

    expect(failure?.message).toMatch(/later\.yml.*concluded "failure"/u);
    expect(failure?.calls).not.toContain("/statuses/");
  });
});

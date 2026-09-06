import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
  actor = "dependabot[bot]",
  changedFiles,
  commits = [dependabotCommit()],
  headRef,
  trustedBaseDirectory,
}: {
  actor?: string;
  changedFiles: string[];
  commits?: ReturnType<typeof dependabotCommit>[];
  headRef: string;
  trustedBaseDirectory: string;
}) {
  return authorizeDependabotUpdate({
    actor,
    changedFiles,
    commits,
    event: pullRequestEvent(
      headRef,
      actor === "dependabot[bot]" ? "opened" : "synchronize",
    ),
    trustedBaseDirectory,
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

describe("Dependabot auto-merge authorization", () => {
  it("authorizes npm lock-only updates from an npm base", () => {
    expect(
      authorize({
        changedFiles: ["package-lock.json"],
        headRef: "dependabot/npm_and_yarn/vitest-4.1.11",
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
        headRef: "dependabot/npm_and_yarn/vitest-4.1.11",
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
        headRef: "dependabot/npm_and_yarn/vitest-4.1.11",
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
          headRef: "dependabot/npm_and_yarn/vitest-4.1.11",
          trustedBaseDirectory,
        }),
      ).toThrow();
  });

  it("rejects cross-ecosystem updates from a mismatched trusted base", () => {
    expect(() =>
      authorize({
        changedFiles: ["uv.lock"],
        headRef: "dependabot/uv/pytest-9.0.0",
        trustedBaseDirectory: trustedBaseWith(
          "package.json",
          "package-lock.json",
        ),
      }),
    ).toThrow();
    expect(() =>
      authorize({
        changedFiles: ["package-lock.json"],
        headRef: "dependabot/npm_and_yarn/vitest-4.1.11",
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
          headRef: "dependabot/github_actions/actions/checkout-7",
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
          headRef: "dependabot/github_actions/actions/checkout-7",
          trustedBaseDirectory,
        }),
      ).toThrow();
  });

  it("authorizes a verified GitHub Update branch chain", () => {
    expect(
      authorizeDependabotUpdate({
        actor: "Snuffy2",
        changedFiles: ["package-lock.json"],
        commits: [
          dependabotCommit(dependabotSha),
          updateCommit(firstUpdateSha, dependabotSha, firstBaseSha),
          updateCommit(headSha, firstUpdateSha, currentBaseSha),
        ],
        event: pullRequestEvent("dependabot/npm_and_yarn/vitest-4.1.11"),
        trustedBaseDirectory: trustedBaseWith(
          "package.json",
          "package-lock.json",
        ),
      }),
    ).toBe("npm");
  });

  it("rejects an invalid GitHub Update branch chain", () => {
    expect(() =>
      authorizeDependabotUpdate({
        actor: "Snuffy2",
        changedFiles: ["package-lock.json"],
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
        event: pullRequestEvent("dependabot/npm_and_yarn/vitest-4.1.11"),
        trustedBaseDirectory: trustedBaseWith(
          "package.json",
          "package-lock.json",
        ),
      }),
    ).toThrow();
  });
});

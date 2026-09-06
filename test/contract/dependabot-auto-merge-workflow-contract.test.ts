import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { authorizeDependabotUpdate } from "../../.github/scripts/dependabot-auto-merge.mjs";

const dependabotSha = "1".repeat(40);
const firstBaseSha = "2".repeat(40);
const firstUpdateSha = "3".repeat(40);
const currentBaseSha = "4".repeat(40);
const headSha = "5".repeat(40);
const temporaryDirectories: string[] = [];

function pullRequestEvent(action = "synchronize") {
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
        ref: "dependabot/npm_and_yarn/vitest-4.0.0",
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

function trustedBaseWith(path: string) {
  const directory = mkdtempSync(join(tmpdir(), "dependabot-authorizer-"));
  temporaryDirectories.push(directory);
  const file = join(directory, path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "fixture\n");
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

describe("Dependabot auto-merge authorization", () => {
  it("authorizes a verified direct npm update with its lockfile", () => {
    expect(
      authorizeDependabotUpdate({
        actor: "dependabot[bot]",
        changedFiles: ["package.json", "package-lock.json"],
        commits: [dependabotCommit()],
        event: pullRequestEvent("opened"),
      }),
    ).toBe("npm");
  });

  it.each([
    ["omits the manifest", ["package-lock.json"]],
    ["omits the lockfile", ["package.json"]],
    [
      "includes a bundle",
      ["package.json", "package-lock.json", "dist/index.js"],
    ],
  ])("rejects an npm update that %s", (_reason, changedFiles) => {
    expect(() =>
      authorizeDependabotUpdate({
        actor: "dependabot[bot]",
        changedFiles,
        commits: [dependabotCommit()],
        event: pullRequestEvent("opened"),
      }),
    ).toThrow();
  });

  it("authorizes an existing top-level workflow update", () => {
    const event = pullRequestEvent("opened");
    event.pull_request.head.ref =
      "dependabot/github_actions/actions/checkout-7";
    expect(
      authorizeDependabotUpdate({
        actor: "dependabot[bot]",
        changedFiles: [".github/workflows/ci.yml"],
        commits: [dependabotCommit()],
        event,
        trustedBaseDirectory: trustedBaseWith(".github/workflows/ci.yml"),
      }),
    ).toBe("github-actions");
  });

  it("authorizes the existing root action manifest", () => {
    const event = pullRequestEvent("opened");
    event.pull_request.head.ref =
      "dependabot/github_actions/actions/checkout-7";
    expect(
      authorizeDependabotUpdate({
        actor: "dependabot[bot]",
        changedFiles: ["action.yml"],
        commits: [dependabotCommit()],
        event,
        trustedBaseDirectory: trustedBaseWith("action.yml"),
      }),
    ).toBe("github-actions");
  });

  it.each([
    [".github/workflows/nested/ci.yml", ".github/workflows/ci.yml"],
    ["action.yml", ".github/workflows/ci.yml"],
  ])("rejects an untrusted GitHub Actions path", (changedFile, trustedFile) => {
    const event = pullRequestEvent("opened");
    event.pull_request.head.ref =
      "dependabot/github_actions/actions/checkout-7";
    expect(() =>
      authorizeDependabotUpdate({
        actor: "dependabot[bot]",
        changedFiles: [changedFile],
        commits: [dependabotCommit()],
        event,
        trustedBaseDirectory: trustedBaseWith(trustedFile),
      }),
    ).toThrow();
  });

  it("authorizes a verified GitHub Update branch chain", () => {
    expect(
      authorizeDependabotUpdate({
        actor: "Snuffy2",
        changedFiles: ["package.json", "package-lock.json"],
        commits: [
          dependabotCommit(dependabotSha),
          updateCommit(firstUpdateSha, dependabotSha, firstBaseSha),
          updateCommit(headSha, firstUpdateSha, currentBaseSha),
        ],
        event: pullRequestEvent(),
      }),
    ).toBe("npm");
  });

  it("rejects a direct maintainer edit before an Update branch merge", () => {
    const maintainerSha = "6".repeat(40);
    expect(() =>
      authorizeDependabotUpdate({
        actor: "Snuffy2",
        changedFiles: ["package.json", "package-lock.json"],
        commits: [
          dependabotCommit(dependabotSha),
          {
            author: { login: "Snuffy2" },
            parents: [{ sha: dependabotSha }],
            sha: maintainerSha,
          },
          updateCommit(headSha, maintainerSha, currentBaseSha),
        ],
        event: pullRequestEvent(),
      }),
    ).toThrow();
  });
});

import * as core from "@actions/core";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionContext, GitHubClient } from "../../src/contracts.js";
import {
  parseInputs,
  resolveAuthenticatedLogin,
  shouldUpdate,
  validateCheckout,
} from "../../src/input.js";

vi.mock("@actions/core", () => ({
  getInput: vi.fn(),
  setSecret: vi.fn(),
}));

const DEFAULT_INPUTS: Readonly<Record<string, string>> = {
  "token": "token",
  "author-login": "github-actions[bot]",
  "cooldown-days": "7",
  "update-day": "1",
  "update-branch": "chore/prek-updates",
  "branch-prefix": "chore/prek-updates",
  "label": "dependencies",
  "commit-message": "chore: update prek hooks",
  "pr-title": "Bump prek Hooks",
  "add-paths": "",
};
const execFileAsync = promisify(execFile);

async function git(directory: string, ...arguments_: string[]): Promise<void> {
  await execFileAsync("git", ["-C", directory, ...arguments_]);
}

function checkoutContext(
  workspace: string,
  repositoryFullName = "example/project",
): ActionContext {
  return {
    authenticatedLogin: "prek-bot",
    baseBranch: "main",
    baseSha: "0".repeat(40),
    eventName: "schedule",
    owner: "example",
    repository: "project",
    repositoryFullName,
    workspace,
  };
}

async function initializedRepository(remoteUrl: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "prek-checkout-test-"));
  await git(directory, "init", "--initial-branch=main");
  await git(directory, "remote", "add", "origin", remoteUrl);
  return directory;
}

describe("parseInputs", () => {
  beforeEach(() => {
    vi.mocked(core.getInput).mockImplementation(
      (name) => DEFAULT_INPUTS[name] ?? "",
    );
  });

  it("maps the public action inputs", () => {
    process.env.INPUT_TOKEN = "token";
    expect(parseInputs()).toEqual({
      token: "token",
      authorLogin: "github-actions[bot]",
      cooldownDays: "7",
      updateDay: 1,
      updateBranch: "chore/prek-updates",
      branchPrefix: "chore/prek-updates",
      label: "dependencies",
      commitMessage: "chore: update prek hooks",
      prTitle: "Bump prek Hooks",
      addPaths: [],
    });
    expect(core.setSecret).toHaveBeenCalledWith("token");
    expect(process.env.INPUT_TOKEN).toBeUndefined();
  });

  it("deletes INPUT_TOKEN even though other action inputs remain available", () => {
    process.env.INPUT_TOKEN = "token";
    process.env.INPUT_LABEL = "dependencies";

    parseInputs();

    expect(process.env.INPUT_TOKEN).toBeUndefined();
    expect(process.env.INPUT_LABEL).toBe("dependencies");
    delete process.env.INPUT_LABEL;
  });

  it("parses nonempty newline-separated add paths", () => {
    vi.mocked(core.getInput).mockImplementation((name) =>
      name === "add-paths"
        ? "prek.toml\n\n docs/file.md \r\n"
        : (DEFAULT_INPUTS[name] ?? ""),
    );

    expect(parseInputs().addPaths).toEqual(["prek.toml", "docs/file.md"]);
  });

  it.each([
    ["", 0],
    ["7", 7],
    ["Mon", Number.NaN],
    ["-1", -1],
  ])(
    "defers validation of update-day %j until the guarded update phase",
    (updateDay, expected) => {
      vi.mocked(core.getInput).mockImplementation((name) =>
        name === "update-day" ? updateDay : (DEFAULT_INPUTS[name] ?? ""),
      );

      expect(parseInputs().updateDay).toEqual(expected);
    },
  );
});

describe("resolveAuthenticatedLogin", () => {
  function clientWithAuthenticatedUser(
    implementation: () => Promise<unknown>,
  ): GitHubClient {
    return {
      rest: {
        users: {
          getAuthenticated: vi.fn(implementation),
        },
      },
    } as unknown as GitHubClient;
  }

  it("uses the login discovered for a user token", async () => {
    const client = clientWithAuthenticatedUser(async () => ({
      data: { login: "exact-user-login" },
    }));

    await expect(
      resolveAuthenticatedLogin(client, "token", "fallback[bot]"),
    ).resolves.toBe("exact-user-login");
  });

  it.each([401, 403])(
    "uses the configured author fallback when GET /user returns %i",
    async (status) => {
      const client = clientWithAuthenticatedUser(async () => {
        throw { status };
      });

      await expect(
        resolveAuthenticatedLogin(client, "token", "custom-app[bot]"),
      ).resolves.toBe("custom-app[bot]");
    },
  );

  it("propagates failures unrelated to installation-token authentication", async () => {
    const failure = Object.assign(new Error("service unavailable"), {
      status: 500,
    });
    const client = clientWithAuthenticatedUser(async () => {
      throw failure;
    });

    await expect(
      resolveAuthenticatedLogin(client, "token", "fallback[bot]"),
    ).rejects.toBe(failure);
  });
});

describe("validateCheckout", () => {
  it("rejects credentials persisted by actions/checkout", async () => {
    const directory = await initializedRepository(
      "https://github.com/example/project.git",
    );
    try {
      await git(
        directory,
        "config",
        "--local",
        "http.https://github.com/.extraheader",
        "AUTHORIZATION: basic secret",
      );

      await expect(
        validateCheckout(checkoutContext(directory)),
      ).rejects.toThrow(
        "The caller checkout must use actions/checkout with persist-credentials: false",
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("does not expose credentials from a mismatched origin URL", async () => {
    const credentialedUrl =
      "https://sensitive-user:sensitive-token@github.com/attacker/project.git";
    const directory = await initializedRepository(credentialedUrl);
    try {
      let failure: unknown;
      try {
        await validateCheckout(checkoutContext(directory));
      } catch (error: unknown) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(
        "The caller checkout origin does not match the workflow repository",
      );
      expect((failure as Error).message).not.toContain("sensitive-user");
      expect((failure as Error).message).not.toContain("sensitive-token");
      expect((failure as Error).message).not.toContain(credentialedUrl);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

describe("shouldUpdate", () => {
  const monday = new Date("2026-07-27T02:00:00Z");

  it("always updates manual runs", () => {
    expect(shouldUpdate("workflow_dispatch", 0, monday)).toBe(true);
  });

  it("updates schedules only on the configured UTC weekday", () => {
    expect(shouldUpdate("schedule", 1, monday)).toBe(true);
    expect(shouldUpdate("schedule", 2, monday)).toBe(false);
  });

  it("never updates push runs", () => {
    expect(shouldUpdate("push", 1, monday)).toBe(false);
  });
});

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
  normalizeServerUrl,
  resolveAuthenticatedIdentity,
  shouldUpdate,
  validateCheckout,
} from "../../src/input.js";

vi.mock("@actions/core", () => ({
  getInput: vi.fn(),
  setSecret: vi.fn(),
}));

const DEFAULT_INPUTS: Readonly<Record<string, string>> = {
  "token": "token",
  "auto-merge": "false",
  "author-login": "github-actions[bot]",
  "cooldown-days": "7",
  "update-day": "1",
  "update-branch": "chore/prek-updates",
  "branch-prefix": "chore/prek-updates",
  "label": "dependencies",
  "commit-message": "",
  "pr-title": "",
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
    tokenAuthenticatedAsUser: true,
    baseBranch: "main",
    baseSha: "0".repeat(40),
    eventName: "schedule",
    owner: "example",
    repository: "project",
    repositoryFullName,
    serverUrl: "https://github.com",
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
      autoMerge: false,
      authorLogin: "github-actions[bot]",
      cooldownDays: "7",
      updateDay: 1,
      updateBranch: "chore/prek-updates",
      branchPrefix: "chore/prek-updates",
      label: "dependencies",
      commitMessage: "chore: update prek hooks",
      prTitle: "chore: update prek hooks",
      addPaths: [],
    });
    expect(core.setSecret).toHaveBeenCalledWith("token");
    expect(process.env.INPUT_TOKEN).toBeUndefined();
  });

  it.each([
    ["prefix: fix", "fix: update prek hooks"],
    ['"prefix": fix', "fix: update prek hooks"],
    ["# Commit format\nprefix: ci\n", "ci: update prek hooks"],
    ['prefix: "Update "', "Update update prek hooks"],
    ['prefix: "chore:"', "chore: update prek hooks"],
    ['prefix: "[hooks]"', "[hooks]: update prek hooks"],
    ['prefix: "🔧"', "🔧 update prek hooks"],
    ['prefix: ""', "update prek hooks"],
    ["{}", "chore: update prek hooks"],
    ['{"prefix":"ci"}', "ci: update prek hooks"],
    ["prefix: " + "a".repeat(50), "a".repeat(50) + ": update prek hooks"],
  ])("uses %j for both the commit and PR title", (input, subject) => {
    vi.mocked(core.getInput).mockImplementation((name) =>
      name === "commit-message" ? input : (DEFAULT_INPUTS[name] ?? ""),
    );

    expect(parseInputs()).toMatchObject({
      commitMessage: subject,
      prTitle: subject,
    });
  });

  it.each([
    ["Custom message", "", "Custom message", "Bump prek Hooks"],
    [
      "chore: update custom hooks",
      "Custom title",
      "chore: update custom hooks",
      "Custom title",
    ],
    ["", "Custom title", "chore: update prek hooks", "Custom title"],
    ["Update [hooks]", "", "Update [hooks]", "Bump prek Hooks"],
    [
      "chore: update hooks\n\nDetails about the update",
      "",
      "chore: update hooks\n\nDetails about the update",
      "Bump prek Hooks",
    ],
  ])(
    "preserves legacy string settings %j and %j",
    (input, title, commitMessage, prTitle) => {
      vi.mocked(core.getInput).mockImplementation((name) => {
        if (name === "commit-message") return input;
        if (name === "pr-title") return title;
        return DEFAULT_INPUTS[name] ?? "";
      });

      expect(parseInputs()).toMatchObject({ commitMessage, prTitle });
    },
  );

  it("gives explicit YAML settings priority over a legacy PR title", () => {
    vi.mocked(core.getInput).mockImplementation((name) => {
      if (name === "commit-message") return "prefix: fix";
      if (name === "pr-title") return "Conflicting title";
      return DEFAULT_INPUTS[name] ?? "";
    });

    expect(parseInputs()).toMatchObject({
      commitMessage: "fix: update prek hooks",
      prTitle: "fix: update prek hooks",
    });
  });

  it.each([
    ["prefix: [", "valid YAML mapping"],
    ["{ }\n[]", "YAML mapping"],
    ["prefix: fix\nprefix: ci", "valid YAML mapping"],
    ["prefix: fix\nunknown: value", "Unknown commit-message option"],
    ["prefix: 123", "prefix must be a single-line string"],
    ["prefix: null", "prefix must be a single-line string"],
    ["prefix: " + "a".repeat(51), "prefix must be a single-line string"],
    ['prefix: "first\\nsecond"', "prefix must be a single-line string"],
  ])("rejects invalid YAML configuration %j", (input, error) => {
    vi.mocked(core.getInput).mockImplementation((name) =>
      name === "commit-message" ? input : (DEFAULT_INPUTS[name] ?? ""),
    );

    expect(() => parseInputs()).toThrow(error);
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

  it("enables auto-merge only from an explicit true input", () => {
    vi.mocked(core.getInput).mockImplementation((name) =>
      name === "auto-merge" ? "true" : (DEFAULT_INPUTS[name] ?? ""),
    );

    expect(parseInputs().autoMerge).toBe(true);
  });

  it.each(["", "yes", "TRUE", "1"])(
    "rejects invalid auto-merge value %j",
    (autoMerge) => {
      vi.mocked(core.getInput).mockImplementation((name) =>
        name === "auto-merge" ? autoMerge : (DEFAULT_INPUTS[name] ?? ""),
      );

      expect(() => parseInputs()).toThrow("auto-merge must be true or false");
    },
  );

  it.each([
    ["0", 0],
    ["6", 6],
    ["6.0", 6],
  ])("accepts update-day %j as %i", (updateDay, expected) => {
    vi.mocked(core.getInput).mockImplementation((name) =>
      name === "update-day" ? updateDay : (DEFAULT_INPUTS[name] ?? ""),
    );

    expect(parseInputs().updateDay).toBe(expected);
  });

  it.each(["", "NaN", "Mon", "1.5", "-1", "7"])(
    "rejects invalid update-day %j while parsing inputs",
    (updateDay) => {
      vi.mocked(core.getInput).mockImplementation((name) =>
        name === "update-day" ? updateDay : (DEFAULT_INPUTS[name] ?? ""),
      );

      expect(() => parseInputs()).toThrow(
        "update-day must be an integer from 0 through 6",
      );
    },
  );
});

describe("resolveAuthenticatedIdentity", () => {
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
      resolveAuthenticatedIdentity(client, "token", "fallback[bot]"),
    ).resolves.toEqual({
      authenticatedAsUser: true,
      login: "exact-user-login",
    });
  });

  it.each([401, 403])(
    "uses the configured author fallback when GET /user returns %i",
    async (status) => {
      const client = clientWithAuthenticatedUser(async () => {
        throw { status };
      });

      await expect(
        resolveAuthenticatedIdentity(client, "token", "custom-app[bot]"),
      ).resolves.toEqual({
        authenticatedAsUser: false,
        login: "custom-app[bot]",
      });
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
      resolveAuthenticatedIdentity(client, "token", "fallback[bot]"),
    ).rejects.toBe(failure);
  });
});

describe("validateCheckout", () => {
  it.each([
    "https://github.example.com/example/project.git",
    "ssh://git@github.example.com/example/project.git",
    "git@github.example.com:example/project.git",
  ])("accepts a matching GitHub Enterprise checkout remote %s", async (url) => {
    const directory = await initializedRepository(url);
    try {
      await expect(
        validateCheckout({
          ...checkoutContext(directory),
          serverUrl: "https://github.example.com",
        }),
      ).resolves.toBeUndefined();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects a checkout on a different server even when its repository path matches", async () => {
    const directory = await initializedRepository(
      "https://github.com/example/project.git",
    );
    try {
      await expect(
        validateCheckout({
          ...checkoutContext(directory),
          serverUrl: "https://github.example.com",
        }),
      ).rejects.toThrow(
        "The caller checkout origin does not match the workflow repository",
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

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

describe("normalizeServerUrl", () => {
  it("normalizes a trailing slash to an HTTPS origin", () => {
    expect(normalizeServerUrl("https://github.example.com:8443/")).toBe(
      "https://github.example.com:8443",
    );
  });

  it.each([
    "http://github.example.com",
    "https://user@github.example.com",
    "https://github.example.com/path",
    "not a URL",
  ])("rejects invalid Actions server URL %j", (serverUrl) => {
    expect(() => normalizeServerUrl(serverUrl)).toThrow(
      "GITHUB_SERVER_URL must be a valid HTTPS origin",
    );
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

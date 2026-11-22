import type * as core from "@actions/core";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

const prekMocks = vi.hoisted(() => ({
  cleanup: vi.fn(async () => undefined),
  install: vi.fn(),
}));
vi.mock("@actions/core", async (importOriginal) => {
  const actual = await importOriginal<typeof core>();
  return { ...actual, warning: vi.fn() };
});
vi.mock("../../src/prek/index.js", () => ({ installPrek: prekMocks.install }));

import type { ActionExecution, GitHubClient } from "../../src/contracts.js";
import { InMemoryGitHub } from "../support/in-memory-github.js";
import { BODY_MARKER } from "../../src/ownership.js";
import {
  runUpdate,
  sanitizeOutput,
  validateAddPath,
  validateUpdateConfiguration,
} from "../../src/update/index.js";
import { createTemporaryRoot } from "../../src/update/worktree.js";

const exec = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

prekMocks.install.mockImplementation(async () => ({
  binary: "/usr/bin/true",
  cleanup: prekMocks.cleanup,
}));

describe("temporary root creation", () => {
  it("removes the raw root when canonicalization fails", async () => {
    const rawRoot = await mkdtemp(path.join(tmpdir(), "prek-root-test-"));
    const resolutionError = new Error("realpath failed");

    await expect(
      createTemporaryRoot(
        async () => rawRoot,
        async () => {
          throw resolutionError;
        },
      ),
    ).rejects.toBe(resolutionError);
    await expect(access(rawRoot)).rejects.toThrow();
  });

  it("retains resolution and cleanup failures together", async () => {
    const rawRoot = await mkdtemp(path.join(tmpdir(), "prek-root-test-"));
    temporaryDirectories.push(rawRoot);
    const resolutionError = new Error("realpath failed");
    const cleanupError = new Error("cleanup failed");

    await expect(
      createTemporaryRoot(
        async () => rawRoot,
        async () => {
          throw resolutionError;
        },
        async () => {
          throw cleanupError;
        },
      ),
    ).rejects.toMatchObject({
      message: "Temporary root resolution failed and cleanup also failed",
      cause: resolutionError,
      errors: [resolutionError, cleanupError],
    });
    await expect(access(rawRoot)).resolves.toBeUndefined();
  });
});

describe("update path validation", () => {
  it.each([
    "/etc/passwd",
    "../prek.toml",
    "config/../../secret",
    ":(glob)**",
    "C:\\secret",
  ])("rejects unsafe path %s", (candidate) => {
    expect(() => validateAddPath(candidate)).toThrow(/Unsafe add-path/u);
  });

  it.each(["prek.toml", ".pre-commit-config.yaml", "config/hooks.yaml"])(
    "accepts repository-relative literal path %s",
    (candidate) => {
      expect(() => validateAddPath(candidate)).not.toThrow();
    },
  );
});

describe("captured output", () => {
  it("removes terminal controls, hides the checkout path, and bounds output", () => {
    const output = `\u001B[31m/work/repo\u001B[0m\u0000${"x".repeat(40_000)}`;
    const sanitized = sanitizeOutput(output, "/work/repo");
    expect(sanitized).toContain("$GITHUB_WORKSPACE");
    expect(sanitized).not.toContain("\u001B");
    expect(sanitized).not.toContain("\u0000");
    expect(sanitized).toMatch(/\[output truncated\]$/u);
  });
});

describe("non-mutating update preflight", () => {
  it("auto-detects one config without mutating GitHub", async () => {
    const execution = await makeExecution(["prek.toml"]);
    await expect(
      validateUpdateConfiguration(execution),
    ).resolves.toBeUndefined();
  });

  it.each<{
    name: string;
    files: readonly string[];
    remoteSha?: string;
  }>([
    {
      name: "ambiguous config discovery",
      files: ["prek.toml", ".pre-commit-config.yaml"],
    },
    {
      name: "a stale remote branch",
      files: ["prek.toml"],
      remoteSha: "abc123",
    },
    {
      name: "a missing config",
      files: [],
    },
  ])("permits $name for cleanup-only events", async ({ files, remoteSha }) => {
    const execution = await makeExecution(files, remoteSha);
    await expect(
      validateUpdateConfiguration(execution),
    ).resolves.toBeUndefined();
  });

  it.each([
    [{ updateDay: -1 }, /update-day/u],
    [{ updateDay: 7 }, /update-day/u],
    [{ cooldownDays: "-1" }, /cooldown-days/u],
    [{ cooldownDays: "1.5" }, /cooldown-days/u],
  ])("rejects invalid update scheduling input", async (override, message) => {
    const execution = await makeExecution([]);
    await expect(
      validateUpdateConfiguration({
        ...execution,
        inputs: { ...execution.inputs, ...override },
      }),
    ).rejects.toThrow(message);
  });

  it("allows independent update branch and trailing-slash cleanup prefix", async () => {
    const execution = await makeExecution([]);
    await expect(
      validateUpdateConfiguration({
        ...execution,
        inputs: {
          ...execution.inputs,
          branchPrefix: "automation/",
          updateBranch: "chore/prek-updates",
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects update or cleanup namespaces that include the base branch", async () => {
    const execution = await makeExecution([]);
    await expect(
      validateUpdateConfiguration({
        ...execution,
        inputs: { ...execution.inputs, updateBranch: "main" },
      }),
    ).rejects.toThrow(/differ/u);
    await expect(
      validateUpdateConfiguration({
        ...execution,
        inputs: { ...execution.inputs, branchPrefix: "ma" },
      }),
    ).rejects.toThrow(/base branch/u);
  });

  it.each([
    ".hidden",
    "chore/.hidden/update",
    "chore/update.lock",
    "chore/update/.lock",
    "@",
  ])("rejects Git-invalid update branch %s", async (updateBranch) => {
    const execution = await makeExecution([]);
    await expect(
      validateUpdateConfiguration({
        ...execution,
        inputs: { ...execution.inputs, updateBranch },
      }),
    ).rejects.toThrow(/Invalid update-branch/u);
  });

  it.each([".automation/", "automation/.hidden/", "automation/owned.lock/"])(
    "rejects Git-invalid cleanup prefix %s",
    async (branchPrefix) => {
      const execution = await makeExecution([]);
      await expect(
        validateUpdateConfiguration({
          ...execution,
          inputs: { ...execution.inputs, branchPrefix },
        }),
      ).rejects.toThrow(/Invalid branch-prefix/u);
    },
  );

  it("creates a missing ownership label and completes the update", async () => {
    const execution = await makeExecution(["prek.toml"]);
    execution.api.labels.delete("dependencies");

    await expect(runUpdate(execution, execution.api)).resolves.toEqual({
      operation: "none",
    });
    expect(execution.api.labels.has("dependencies")).toBe(true);
  });

  it("does not create labels during configuration validation", async () => {
    const execution = await makeExecution([]);
    execution.api.labels.delete("dependencies");

    await validateUpdateConfiguration(execution);
    expect(execution.api.labels.has("dependencies")).toBe(false);
  });

  it("uses an existing label without changing it", async () => {
    const execution = await makeExecution(["prek.toml"]);
    execution.api.labels.set("dependencies", "ff0000");

    await expect(runUpdate(execution, execution.api)).resolves.toEqual({
      operation: "none",
    });
    expect(execution.api.labels.get("dependencies")).toBe("ff0000");
  });

  it("accepts a label created concurrently by another run", async () => {
    const execution = await makeExecution(["prek.toml"]);
    execution.api.labels.delete("dependencies");
    execution.api.transitions.beforeCreateLabel = (name) => {
      execution.api.labels.set(name, "ff0000");
    };

    await expect(runUpdate(execution, execution.api)).resolves.toEqual({
      operation: "none",
    });
    expect(execution.api.labels.get("dependencies")).toBe("ff0000");
  });

  it.each([403, 500])("propagates label lookup failure %s", async (status) => {
    const execution = await makeExecution(["prek.toml"]);
    execution.api.labels.delete("dependencies");
    const error = Object.assign(new Error("lookup failed"), { status });
    execution.api.transitions.beforeLookupLabel = () => {
      throw error;
    };

    await expect(runUpdate(execution, execution.api)).rejects.toBe(error);
    expect(execution.api.labels.has("dependencies")).toBe(false);
    expect(prekMocks.install).not.toHaveBeenCalled();
  });

  it.each([403, 422, 500])(
    "propagates label creation failure %s",
    async (status) => {
      const execution = await makeExecution(["prek.toml"]);
      execution.api.labels.delete("dependencies");
      const error = Object.assign(new Error("creation failed"), { status });
      execution.api.transitions.beforeCreateLabel = () => {
        throw error;
      };

      await expect(runUpdate(execution, execution.api)).rejects.toBe(error);
      expect(execution.api.labels.has("dependencies")).toBe(false);
      expect(prekMocks.install).not.toHaveBeenCalled();
    },
  );

  it.each(["github-actions[bot]", "pat-owner"])(
    "uses authenticated login %s for ownership",
    async (authenticatedLogin) => {
      const execution = await makeExecution(
        ["prek.toml"],
        "BASE",
        [ownedPull(authenticatedLogin)],
        authenticatedLogin,
      );
      await expect(runUpdate(execution, execution.api)).resolves.toMatchObject({
        operation: "closed",
      });
      expect(execution.api.pulls.get(42)?.state).toBe("closed");
      expect(execution.api.refs.has("heads/chore/prek-updates")).toBe(false);
    },
  );

  it("ignores historical closed pull requests", async () => {
    const execution = await makeExecution(["prek.toml"], undefined, [
      { ...ownedPull("somebody-else"), state: "closed", labels: [] },
    ]);
    await expect(runUpdate(execution, execution.api)).resolves.toEqual({
      operation: "none",
    });
    expect(execution.api.pulls.get(42)?.state).toBe("closed");
  });

  it("requires the configured ownership label", async () => {
    const execution = await makeExecution(["prek.toml"], "abc123", [
      { ...ownedPull("github-actions[bot]"), labels: [] },
    ]);
    await expect(runUpdate(execution, execution.api)).rejects.toThrow(
      /not owned/u,
    );
  });

  it("rejects ambiguous config discovery before running prek", async () => {
    const execution = await makeExecution([
      "prek.toml",
      ".pre-commit-config.yaml",
    ]);
    await expect(runUpdate(execution, execution.api)).rejects.toThrow(
      /exactly one/u,
    );
  });

  it("rejects an unassociated update branch before running prek", async () => {
    const execution = await makeExecution(["prek.toml"], "abc123");
    await expect(runUpdate(execution, execution.api)).rejects.toThrow(
      /not owned/u,
    );
  });

  it("cleans its detached worktree on no change", async () => {
    const execution = await makeExecution(["prek.toml"]);
    await expect(runUpdate(execution, execution.api)).resolves.toEqual({
      operation: "none",
    });
    const { stdout: status } = await exec("git", [
      "-C",
      execution.context.workspace,
      "status",
      "--porcelain",
    ]);
    const { stdout: worktrees } = await exec("git", [
      "-C",
      execution.context.workspace,
      "worktree",
      "list",
      "--porcelain",
    ]);
    expect(status).toBe("");
    expect(worktrees.match(/^worktree /gmu)).toHaveLength(1);
    expect(prekMocks.cleanup).toHaveBeenCalledOnce();
  });

  it("uses the prek autoupdate compatibility command", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "prek-command-test-"));
    temporaryDirectories.push(directory);
    const argumentsFile = path.join(directory, "arguments");
    const binary = path.join(directory, "prek");
    await writeFile(
      binary,
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${argumentsFile}'\n`,
      { mode: 0o755 },
    );
    prekMocks.install.mockResolvedValueOnce({
      binary,
      cleanup: prekMocks.cleanup,
    });
    const execution = await makeExecution(["prek.toml"]);

    await expect(runUpdate(execution, execution.api)).resolves.toEqual({
      operation: "none",
    });
    await expect(readFile(argumentsFile, "utf8")).resolves.toBe(
      "autoupdate\n--cooldown-days\n7\n",
    );
  });

  it("cleans the installation when running prek fails", async () => {
    prekMocks.install.mockResolvedValueOnce({
      binary: "/missing/prek",
      cleanup: prekMocks.cleanup,
    });
    const execution = await makeExecution(["prek.toml"]);

    await expect(runUpdate(execution, execution.api)).rejects.toThrow();
    expect(prekMocks.cleanup).toHaveBeenCalledOnce();
  });

  it("reports cleanup failure after a successful update operation", async () => {
    const cleanupError = new Error("installation cleanup failed");
    prekMocks.cleanup.mockRejectedValueOnce(cleanupError);
    const execution = await makeExecution(["prek.toml"]);

    await expect(runUpdate(execution, execution.api)).rejects.toMatchObject({
      message: "Update operation completed but cleanup failed",
      errors: [cleanupError],
    });
  });

  it("retains update and cleanup failures together", async () => {
    const cleanupError = new Error("installation cleanup failed");
    prekMocks.cleanup.mockRejectedValueOnce(cleanupError);
    prekMocks.install.mockResolvedValueOnce({
      binary: "/missing/prek",
      cleanup: prekMocks.cleanup,
    });
    const execution = await makeExecution(["prek.toml"]);

    const error = await runUpdate(execution, execution.api).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({
      message: "Update failed and cleanup also failed",
    });
    expect((error as AggregateError).errors).toEqual([
      expect.any(Error),
      cleanupError,
    ]);
  });
});

async function makeExecution(
  files: readonly string[],
  remoteSha?: string,
  pulls: readonly (Record<string, unknown> & { number: number })[] = [],
  authenticatedLogin = "github-actions[bot]",
): Promise<ActionExecution & { api: InMemoryGitHub }> {
  const workspace = await mkdtemp(path.join(tmpdir(), "prek-update-test-"));
  temporaryDirectories.push(workspace);
  await exec("git", ["init", "-b", "main", workspace]);
  await exec("git", ["-C", workspace, "config", "user.name", "Test"]);
  await exec("git", [
    "-C",
    workspace,
    "config",
    "user.email",
    "test@example.com",
  ]);
  for (const file of files) {
    await writeFile(path.join(workspace, file), "");
  }
  await exec("git", ["-C", workspace, "add", "."]);
  await exec("git", ["-C", workspace, "commit", "--allow-empty", "-m", "base"]);
  const { stdout } = await exec("git", ["-C", workspace, "rev-parse", "HEAD"]);

  const baseSha = stdout.trim();
  const resolvedRemoteSha = remoteSha === "BASE" ? baseSha : remoteSha;
  const effectivePulls = pulls.map((pull) => {
    const head = pull.head as Record<string, unknown> | undefined;
    return head?.sha === "BASE"
      ? { ...pull, head: { ...head, sha: baseSha } }
      : pull;
  });
  const api = new InMemoryGitHub(effectivePulls, authenticatedLogin);
  api.refs.set("heads/main", baseSha);
  if (resolvedRemoteSha !== undefined) {
    api.refs.set("heads/chore/prek-updates", resolvedRemoteSha);
  }
  api.labels.set("dependencies", "0366d6");
  return {
    api,
    client: {} as GitHubClient,
    context: {
      authenticatedLogin,
      baseBranch: "main",
      baseSha,
      eventName: "schedule",
      owner: "owner",
      repository: "repo",
      repositoryFullName: "owner/repo",
      serverUrl: "https://github.com",
      workspace,
      tokenAuthenticatedAsUser: true,
    },
    inputs: {
      addPaths: [],
      autoMerge: false,
      authorLogin: "github-actions[bot]",
      branchPrefix: "chore/prek-",
      commitMessage: "update",
      cooldownDays: "7",
      label: "dependencies",
      prTitle: "Update",
      token: "token",
      updateBranch: "chore/prek-updates",
      updateDay: 1,
    },
  };
}

function ownedPull(
  login: string,
): Record<string, unknown> & { number: number } {
  return {
    base: { ref: "main" },
    body: BODY_MARKER,
    head: {
      ref: "chore/prek-updates",
      repo: { full_name: "owner/repo" },
      sha: "BASE",
    },
    labels: [{ name: "dependencies" }],
    number: 42,
    state: "open",
    title: "Update",
    updated_at: "2026-07-28T00:00:00Z",
    user: { login },
  };
}

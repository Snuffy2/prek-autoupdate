import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

const prekMocks = vi.hoisted(() => ({
  cleanup: vi.fn(async () => undefined),
  install: vi.fn(),
}));
vi.mock("../../src/prek/index.js", () => ({ installPrek: prekMocks.install }));

import type { ActionExecution, GitHubClient } from "../../src/contracts.js";
import {
  BODY_MARKER,
  createTemporaryRoot,
  runUpdate,
  sanitizeOutput,
  validateAddPath,
  validateUpdateConfiguration,
} from "../../src/update/index.js";

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

  it("keeps the exact ownership marker stable", () => {
    expect(BODY_MARKER).toBe("Automated update of `prek` hooks.");
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

  it("fails preflight clearly when the ownership label is unavailable", async () => {
    const execution = await makeExecution([]);
    vi.mocked(execution.client.rest.issues.getLabel).mockRejectedValueOnce(
      Object.assign(new Error("missing"), { status: 404 }),
    );

    await expect(validateUpdateConfiguration(execution)).rejects.toThrow(
      /ownership label "dependencies" does not exist or is not accessible/u,
    );
  });

  it.each(["github-actions[bot]", "pat-owner"])(
    "uses authenticated login %s for ownership",
    async (authenticatedLogin) => {
      const execution = await makeExecution(
        ["prek.toml"],
        "BASE",
        [ownedPull(authenticatedLogin)],
        authenticatedLogin,
      );
      await expect(runUpdate(execution)).rejects.toThrow(/branch deletion/u);
    },
  );

  it("ignores historical closed pull requests", async () => {
    const execution = await makeExecution(["prek.toml"], undefined, [
      { ...ownedPull("somebody-else"), state: "closed", labels: [] },
    ]);
    await expect(
      validateUpdateConfiguration(execution),
    ).resolves.toBeUndefined();
  });

  it("requires the configured ownership label", async () => {
    const execution = await makeExecution(["prek.toml"], "abc123", [
      { ...ownedPull("github-actions[bot]"), labels: [] },
    ]);
    await expect(runUpdate(execution)).rejects.toThrow(/not owned/u);
  });

  it("rejects ambiguous config discovery before running prek", async () => {
    const execution = await makeExecution([
      "prek.toml",
      ".pre-commit-config.yaml",
    ]);
    await expect(runUpdate(execution)).rejects.toThrow(/exactly one/u);
  });

  it("rejects an unassociated update branch before running prek", async () => {
    const execution = await makeExecution(["prek.toml"], "abc123");
    await expect(runUpdate(execution)).rejects.toThrow(/not owned/u);
  });

  it("cleans its detached worktree on no change", async () => {
    const execution = await makeExecution(["prek.toml"]);
    await expect(runUpdate(execution)).resolves.toEqual({ operation: "none" });
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

  it("cleans the installation when running prek fails", async () => {
    prekMocks.install.mockResolvedValueOnce({
      binary: "/missing/prek",
      cleanup: prekMocks.cleanup,
    });
    const execution = await makeExecution(["prek.toml"]);

    await expect(runUpdate(execution)).rejects.toThrow();
    expect(prekMocks.cleanup).toHaveBeenCalledOnce();
  });

  it("reports cleanup failure after a successful update operation", async () => {
    const cleanupError = new Error("installation cleanup failed");
    prekMocks.cleanup.mockRejectedValueOnce(cleanupError);
    const execution = await makeExecution(["prek.toml"]);

    await expect(runUpdate(execution)).rejects.toMatchObject({
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

    const error = await runUpdate(execution).catch((caught: unknown) => caught);
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
  pulls: readonly Record<string, unknown>[] = [],
  authenticatedLogin = "github-actions[bot]",
): Promise<ActionExecution> {
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
  const getRef = async ({ ref }: { ref: string }) => {
    if (ref === "heads/main") {
      return { data: { object: { sha: baseSha } } };
    }
    if (resolvedRemoteSha === undefined) {
      throw Object.assign(new Error("missing"), { status: 404 });
    }
    return { data: { object: { sha: resolvedRemoteSha } } };
  };
  const client = {
    paginate: async () => effectivePulls,
    rest: {
      git: { getRef },
      issues: {
        getLabel: vi.fn(async () => ({ data: { name: "dependencies" } })),
      },
      pulls: {
        get: async () => ({ data: effectivePulls[0] }),
        list: async () => ({ data: [] }),
        update: async ({ state }: { state?: string }) => ({
          data: {
            ...effectivePulls[0],
            state: state ?? effectivePulls[0]?.state,
          },
        }),
      },
    },
  } as unknown as GitHubClient;
  return {
    client,
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
    },
    inputs: {
      addPaths: [],
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

function ownedPull(login: string): Record<string, unknown> {
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

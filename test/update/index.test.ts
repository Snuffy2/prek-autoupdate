import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/prek/index.js", () => ({
  installPrek: vi.fn(async () => "/usr/bin/true"),
}));

import type { ActionExecution, GitHubClient } from "../../src/contracts.js";
import {
  BODY_MARKER,
  runUpdate,
  sanitizeOutput,
  validateAddPath,
  validateUpdateConfiguration,
} from "../../src/update/index.js";

const exec = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
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

  it("permits ambiguous config discovery for cleanup-only events", async () => {
    const execution = await makeExecution([
      "prek.toml",
      ".pre-commit-config.yaml",
    ]);
    await expect(
      validateUpdateConfiguration(execution),
    ).resolves.toBeUndefined();
  });

  it("permits a stale remote branch for cleanup-only events", async () => {
    const execution = await makeExecution(["prek.toml"], "abc123");
    await expect(
      validateUpdateConfiguration(execution),
    ).resolves.toBeUndefined();
  });

  it("permits a missing config for cleanup-only events", async () => {
    const execution = await makeExecution([]);
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
      workspace,
    },
    inputs: {
      addPaths: [],
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

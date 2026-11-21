import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import type { ActionExecution, UpdateResult } from "../contracts.js";
import { sanitizedChildEnvironment } from "../environment.js";
import { git, gitExit } from "../git.js";
import { OctokitGitHubApi, type GitHubApi } from "../github.js";
import { BODY_MARKER } from "../ownership.js";
import { installPrek, type PrekInstallation } from "../prek/index.js";
import {
  closeUnneededPullRequest,
  observeRemoteState,
  proveBase,
  publishUpdate,
} from "./publication.js";
import { prepareWorktree } from "./worktree.js";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 32_000;

/** Validate every non-mutating update precondition. */
export async function validateUpdateConfiguration(
  execution: ActionExecution,
): Promise<void> {
  validateCleanupConfiguration(execution);
  if (
    !Number.isInteger(execution.inputs.updateDay) ||
    execution.inputs.updateDay < 0 ||
    execution.inputs.updateDay > 6
  ) {
    throw new Error("update-day must be an integer from 0 through 6");
  }
  if (!/^(?:0|[1-9]\d*)$/u.test(execution.inputs.cooldownDays)) {
    throw new Error("cooldown-days must be a nonnegative integer");
  }
  for (const addPath of execution.inputs.addPaths) {
    validateAddPath(addPath);
  }
  await assertBaseCommit(execution);
}

/** Validate the ownership namespace before cleanup is allowed to mutate. */
export function validateCleanupConfiguration(execution: ActionExecution): void {
  validateBranch(
    execution.inputs.updateBranch,
    execution.inputs.branchPrefix,
    execution.context.baseBranch,
  );
}

/** Run prek in an isolated base-SHA worktree and publish its owned update PR. */
export async function runUpdate(
  execution: ActionExecution,
  api: GitHubApi = new OctokitGitHubApi(
    execution.client,
    execution.context.owner,
    execution.context.repository,
    execution.inputs.token,
    execution.context.serverUrl,
  ),
): Promise<UpdateResult> {
  await validateUpdateConfiguration(execution);
  const addPaths = await resolveAddPaths(execution);
  await proveBase(api, execution);
  const remote = await observeRemoteState(api, execution);
  await api.ensureLabel(execution.inputs.label);
  const detachedWorktree = await prepareWorktree(
    execution.context.workspace,
    execution.context.baseSha,
  );
  const worktree = detachedWorktree.path;
  let installation: PrekInstallation | undefined;
  let updateFailed = false;
  let updateError: unknown;
  try {
    await detachedWorktree.add();
    installation = await installPrek();
    const output = await runPrek(
      installation.binary,
      worktree,
      execution.inputs.cooldownDays,
    );
    await git(worktree, ["add", "--", ...addPaths]);
    const diffStatus = await gitExit(worktree, [
      "diff",
      "--cached",
      "--quiet",
      "--",
      ...addPaths,
    ]);
    if (diffStatus !== 0 && diffStatus !== 1) {
      throw new Error(
        `git diff --cached --quiet failed with status ${diffStatus}`,
      );
    }
    const changed = diffStatus === 1;
    if (!changed) {
      return await closeUnneededPullRequest(api, execution, remote);
    }

    await git(worktree, [
      "-c",
      "user.name=github-actions[bot]",
      "-c",
      "user.email=41898282+github-actions[bot]@users.noreply.github.com",
      "commit",
      "-m",
      execution.inputs.commitMessage,
    ]);
    const newSha = await git(worktree, ["rev-parse", "HEAD"]);
    const body = makeBody(output, execution.context.workspace);
    return await publishUpdate(api, execution, remote, {
      worktree: detachedWorktree,
      sha: newSha,
      body,
    });
  } catch (error) {
    updateFailed = true;
    updateError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    try {
      await installation?.cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await detachedWorktree.cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
    reportCleanupFailures(updateFailed, updateError, cleanupErrors);
  }
}

function reportCleanupFailures(
  updateFailed: boolean,
  updateError: unknown,
  cleanupErrors: readonly unknown[],
): void {
  if (cleanupErrors.length === 0) {
    return;
  }
  if (updateFailed) {
    throw new AggregateError(
      [updateError, ...cleanupErrors],
      "Update failed and cleanup also failed",
      { cause: updateError },
    );
  }
  throw new AggregateError(
    cleanupErrors,
    "Update operation completed but cleanup failed",
  );
}

export function validateAddPath(addPath: string): void {
  if (
    addPath === "" ||
    path.posix.isAbsolute(addPath) ||
    path.win32.isAbsolute(addPath) ||
    addPath.includes("\\") ||
    addPath.split("/").some((segment) => segment === "." || segment === "..") ||
    addPath.startsWith(":") ||
    /[*?[]/u.test(addPath) ||
    addPath.includes("\0")
  ) {
    throw new Error(`Unsafe add-path: ${JSON.stringify(addPath)}`);
  }
}

export function sanitizeOutput(output: string, workspace = ""): string {
  let sanitized = output
    .replace(
      /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/gu,
      "",
    )
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "");
  if (workspace !== "") {
    sanitized = sanitized.replaceAll(workspace, "$GITHUB_WORKSPACE");
  }
  if (sanitized.length > MAX_OUTPUT) {
    sanitized = `${sanitized.slice(0, MAX_OUTPUT)}\n[output truncated]`;
  }
  return sanitized.trim();
}

function validateBranch(
  updateBranch: string,
  prefix: string,
  baseBranch: string,
): void {
  for (const [name, value, allowTrailingSlash] of [
    ["update-branch", updateBranch, false],
    ["branch-prefix", prefix, true],
  ] as const) {
    if (
      value === "" ||
      value.startsWith("-") ||
      value.includes("..") ||
      value.includes("@{") ||
      /[\u0000-\u0020\u007F~^:?*[\]\\]/u.test(value) ||
      value.startsWith("/") ||
      (!allowTrailingSlash && value.endsWith("/")) ||
      value.endsWith(".") ||
      value.includes("//") ||
      value === "@"
    ) {
      throw new Error(`Invalid ${name}: ${JSON.stringify(value)}`);
    }
    const components = (
      allowTrailingSlash ? value.replace(/\/$/u, "") : value
    ).split("/");
    if (
      components.some(
        (component) =>
          component === "" ||
          component.startsWith(".") ||
          component.endsWith(".lock"),
      )
    ) {
      throw new Error(`Invalid ${name}: ${JSON.stringify(value)}`);
    }
  }
  if (updateBranch === baseBranch) {
    throw new Error("update-branch must differ from the base branch");
  }
  if (baseBranch.startsWith(prefix)) {
    throw new Error("branch-prefix must not include the base branch");
  }
}

async function resolveAddPaths(
  execution: ActionExecution,
): Promise<readonly string[]> {
  if (execution.inputs.addPaths.length > 0) {
    return execution.inputs.addPaths;
  }
  const configs = ["prek.toml", ".pre-commit-config.yaml"];
  const existing: string[] = [];
  for (const config of configs) {
    if (
      (await gitExit(execution.context.workspace, [
        "cat-file",
        "-e",
        `${execution.context.baseSha}:${config}`,
      ])) === 0
    ) {
      existing.push(config);
    }
  }
  if (existing.length !== 1) {
    throw new Error(
      "Expected exactly one prek config: prek.toml or .pre-commit-config.yaml",
    );
  }
  return existing;
}

async function assertBaseCommit(execution: ActionExecution): Promise<void> {
  await git(execution.context.workspace, [
    "merge-base",
    "--is-ancestor",
    execution.context.baseSha,
    execution.context.baseSha,
  ]);
}

async function runPrek(
  binary: string,
  worktree: string,
  cooldownDays: string,
): Promise<string> {
  try {
    const result = await execFileAsync(
      binary,
      ["autoupdate", "--cooldown-days", cooldownDays],
      {
        cwd: worktree,
        encoding: "utf8",
        env: sanitizedChildEnvironment(),
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    return `${result.stdout}${result.stderr}`;
  } catch (error) {
    const detail = error as {
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    throw new Error(
      `prek autoupdate failed: ${sanitizeOutput(`${detail.stdout ?? ""}${detail.stderr ?? ""}${detail.message ?? ""}`, worktree)}`,
      { cause: error },
    );
  }
}

function makeBody(output: string, workspace: string): string {
  const detail = sanitizeOutput(output, workspace);
  return detail === ""
    ? BODY_MARKER
    : `${BODY_MARKER}\n\n<details><summary>prek output</summary>\n\n\`\`\`text\n${detail.replaceAll("```", "` ` `")}\n\`\`\`\n</details>`;
}

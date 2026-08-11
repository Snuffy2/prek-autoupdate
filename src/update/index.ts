import * as core from "@actions/core";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { ActionExecution, UpdateResult } from "../contracts.js";
import {
  hardenedGitArguments,
  sanitizedChildEnvironment,
} from "../environment.js";
import { installPrek, type PrekInstallation } from "../prek/index.js";

const execFileAsync = promisify(execFile);
export const BODY_MARKER = "Automated update of `prek` hooks.";
const MAX_OUTPUT = 32_000;

interface RemoteState {
  readonly sha?: string;
  readonly ownedPullRequest?: PullRequest;
}

interface PullRequest {
  readonly number: number;
  readonly author: string | null;
  readonly body: string | null;
  readonly headRef: string;
  readonly headRepository: string | null;
  readonly baseRef: string;
  readonly state: string;
  readonly labels: readonly string[];
  readonly headSha: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
}

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
  await assertOwnershipLabel(execution);
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
): Promise<UpdateResult> {
  await validateUpdateConfiguration(execution);
  const addPaths = await resolveAddPaths(execution);
  await proveBase(execution);
  const remote = await observeRemoteState(execution);
  const temporaryRoot = await createTemporaryRoot();
  const worktree = path.join(temporaryRoot, "worktree");
  let added = false;
  let installation: PrekInstallation | undefined;
  let updateFailed = false;
  let updateError: unknown;
  try {
    added = true;
    await git(execution.context.workspace, [
      "worktree",
      "add",
      "--detach",
      worktree,
      execution.context.baseSha,
    ]);
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
      return await closeUnneededPullRequest(execution, remote);
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
    if (remote.ownedPullRequest !== undefined) {
      await fetchObservedUpdateCommit(execution, worktree, remote);
      await proveCurrentOwnership(execution, remote);
    }
    await proveBase(execution);
    await pushUpdate(execution, worktree, remote.sha);
    if (remote.ownedPullRequest === undefined) {
      let pullNumber: number | undefined;
      try {
        const response = await execution.client.rest.pulls.create({
          owner: execution.context.owner,
          repo: execution.context.repository,
          head: execution.inputs.updateBranch,
          base: execution.context.baseBranch,
          title: execution.inputs.prTitle,
          body,
        });
        pullNumber = response.data.number;
      } catch (error) {
        let recovered: number | undefined;
        try {
          recovered = await recoverAmbiguousCreatedPull(
            execution,
            newSha,
            body,
          );
        } catch (recoveryError) {
          throw new Error(
            "Pull request creation had an ambiguous outcome; the lease-protected update branch was preserved for inspection",
            { cause: new AggregateError([error, recoveryError]) },
          );
        }
        if (recovered !== undefined) {
          pullNumber = recovered;
        } else if (isDefiniteCreateFailure(error)) {
          await rollbackNewBranch(execution, newSha, error);
        } else {
          throw new Error(
            "Pull request creation had an ambiguous outcome; the lease-protected update branch was preserved for inspection",
            {
              cause: new AggregateError([
                error,
                new Error("No exact created pull request was observable"),
              ]),
            },
          );
        }
      }
      if (pullNumber === undefined) {
        throw new Error("Pull request creation did not return a pull number");
      }
      try {
        await applyLabel(execution, pullNumber);
        await proveCreatedOwnership(execution, pullNumber, newSha, body);
      } catch (error) {
        await rollbackCreatedPullRequest(execution, pullNumber, newSha, error);
      }
      return { operation: "created", pullRequestNumber: pullNumber };
    }

    try {
      await provePublishedOwnership(execution, remote, newSha);
    } catch (error) {
      await rollbackExistingPush(execution, remote, newSha, error);
    }
    let pullUpdateError: unknown;
    try {
      const response = await execution.client.rest.pulls.update({
        owner: execution.context.owner,
        repo: execution.context.repository,
        pull_number: remote.ownedPullRequest.number,
        title: execution.inputs.prTitle,
        body,
      });
      const updated = pullFromData(response.data);
      if (
        isExactUpdatedPull(
          execution,
          updated,
          remote.ownedPullRequest.number,
          newSha,
          body,
        )
      ) {
        return {
          operation: "updated",
          pullRequestNumber: remote.ownedPullRequest.number,
        };
      }
      pullUpdateError = new Error(
        "GitHub returned an unexpected pull request after update",
      );
    } catch (error) {
      pullUpdateError = error;
    }
    let verified: PullRequest;
    try {
      const response = await execution.client.rest.pulls.get({
        owner: execution.context.owner,
        repo: execution.context.repository,
        pull_number: remote.ownedPullRequest.number,
      });
      verified = pullFromData(response.data);
      if (
        isExactUpdatedPull(
          execution,
          verified,
          remote.ownedPullRequest.number,
          newSha,
          body,
        )
      ) {
        return {
          operation: "updated",
          pullRequestNumber: remote.ownedPullRequest.number,
        };
      }
    } catch (verificationError) {
      throw new Error(
        "Pull request metadata outcome is ambiguous; the lease-protected new branch was preserved",
        { cause: new AggregateError([pullUpdateError, verificationError]) },
      );
    }
    const verificationError = new Error(
      "Fresh pull request verification was not exact",
    );
    if (isExactOriginalMetadataPull(execution, verified, remote, newSha)) {
      return await rollbackExistingPush(
        execution,
        remote,
        newSha,
        new AggregateError([pullUpdateError, verificationError]),
      );
    }
    throw new Error(
      "Pull request metadata outcome is ambiguous; the lease-protected new branch was preserved",
      { cause: new AggregateError([pullUpdateError, verificationError]) },
    );
  } catch (error) {
    updateFailed = true;
    updateError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    let preserveTemporaryRoot = false;
    try {
      await installation?.cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (added) {
      let removalFailed = false;
      let removalError: unknown;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await git(execution.context.workspace, [
            "worktree",
            "remove",
            "--force",
            ...(attempt === 0 ? [] : ["--force"]),
            worktree,
          ]);
          removalFailed = false;
          break;
        } catch (error) {
          removalFailed = true;
          removalError = error;
        }
      }
      if (removalFailed) {
        try {
          const registeredWorktrees = await git(execution.context.workspace, [
            "worktree",
            "list",
            "--porcelain",
          ]);
          if (
            registeredWorktrees
              .split("\n")
              .some((line) => line === `worktree ${worktree}`)
          ) {
            preserveTemporaryRoot = true;
            cleanupErrors.push(
              new Error(
                `Failed to remove action-owned worktree; ${worktree} was preserved for inspection`,
                { cause: removalError },
              ),
            );
          }
        } catch (inspectionError) {
          preserveTemporaryRoot = true;
          cleanupErrors.push(
            new Error(
              `Failed to reconcile action-owned worktree registration; ${worktree} was preserved for inspection`,
              {
                cause: new AggregateError([removalError, inspectionError]),
              },
            ),
          );
        }
      }
    }
    if (!preserveTemporaryRoot) {
      try {
        await rm(temporaryRoot, { force: true, recursive: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    reportCleanupFailures(updateFailed, updateError, cleanupErrors);
  }
}

export async function createTemporaryRoot(
  create: (prefix: string) => Promise<string> = mkdtemp,
  resolve: (candidate: string) => Promise<string> = realpath,
  remove: (
    candidate: string,
    options: { force: boolean; recursive: boolean },
  ) => Promise<void> = rm,
): Promise<string> {
  const rawRoot = await create(path.join(tmpdir(), "prek-autoupdate-"));
  try {
    return await resolve(rawRoot);
  } catch (error) {
    let cleanupFailed = false;
    let cleanupError: unknown;
    try {
      await remove(rawRoot, { force: true, recursive: true });
    } catch (caughtCleanupError) {
      cleanupFailed = true;
      cleanupError = caughtCleanupError;
    }
    if (cleanupFailed) {
      throw new AggregateError(
        [error, cleanupError],
        "Temporary root resolution failed and cleanup also failed",
        { cause: error },
      );
    }
    throw error;
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

function isExactUpdatedPull(
  execution: ActionExecution,
  pull: PullRequest,
  pullNumber: number,
  newSha: string,
  body: string,
): boolean {
  return (
    isOwned(execution, pull) &&
    pull.state === "open" &&
    pull.number === pullNumber &&
    pull.headSha === newSha &&
    pull.title === execution.inputs.prTitle &&
    bodiesEqual(pull.body, body)
  );
}

function isExactOriginalMetadataPull(
  execution: ActionExecution,
  pull: PullRequest,
  remote: RemoteState,
  newSha: string,
): boolean {
  const original = remote.ownedPullRequest;
  return (
    original !== undefined &&
    isOwned(execution, pull) &&
    pull.state === "open" &&
    pull.number === original.number &&
    pull.headSha === newSha &&
    pull.title === original.title &&
    bodiesEqual(pull.body, original.body)
  );
}

function bodiesEqual(left: string | null, right: string | null): boolean {
  return left?.replaceAll("\r\n", "\n") === right?.replaceAll("\r\n", "\n");
}

async function recoverAmbiguousCreatedPull(
  execution: ActionExecution,
  newSha: string,
  body: string,
): Promise<number | undefined> {
  const pulls = await execution.client.paginate(
    execution.client.rest.pulls.list,
    {
      owner: execution.context.owner,
      repo: execution.context.repository,
      state: "open",
      head: `${execution.context.owner}:${execution.inputs.updateBranch}`,
      base: execution.context.baseBranch,
      per_page: 100,
    },
  );
  const matches = pulls
    .map((pull) => pullFromData(pull))
    .filter(
      (pull) =>
        pull.author === execution.context.authenticatedLogin &&
        pull.state === "open" &&
        pull.body === body &&
        pull.title === execution.inputs.prTitle &&
        pull.headRef === execution.inputs.updateBranch &&
        pull.headRepository?.toLowerCase() ===
          execution.context.repositoryFullName.toLowerCase() &&
        pull.headSha === newSha &&
        pull.baseRef === execution.context.baseBranch,
    );
  return matches.length === 1 ? matches[0]?.number : undefined;
}

async function proveCreatedOwnership(
  execution: ActionExecution,
  pullNumber: number,
  newSha: string,
  body: string,
): Promise<void> {
  const response = await execution.client.rest.pulls.get({
    owner: execution.context.owner,
    repo: execution.context.repository,
    pull_number: pullNumber,
  });
  const pull = pullFromData(response.data);
  if (
    pull.number !== pullNumber ||
    pull.state !== "open" ||
    !isOwned(execution, pull) ||
    pull.headSha !== newSha ||
    pull.title !== execution.inputs.prTitle ||
    pull.body !== body
  ) {
    throw new Error(
      "GitHub did not return the exact owned pull request after creation",
    );
  }
}

async function fetchObservedUpdateCommit(
  execution: ActionExecution,
  worktree: string,
  remote: RemoteState,
): Promise<void> {
  if (remote.sha === undefined) {
    throw new Error("Expected an observed update branch revision");
  }
  await gitAuthenticated(execution, worktree, [
    "fetch",
    "--no-tags",
    repositoryUrl(execution),
    `refs/heads/${execution.inputs.updateBranch}`,
  ]);
  const fetched = await git(worktree, ["rev-parse", "FETCH_HEAD"]);
  if (fetched !== remote.sha) {
    throw new Error(
      "Update branch changed while preparing its rollback commit",
    );
  }
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

async function assertOwnershipLabel(execution: ActionExecution): Promise<void> {
  try {
    await execution.client.rest.issues.getLabel({
      owner: execution.context.owner,
      repo: execution.context.repository,
      name: execution.inputs.label,
    });
  } catch (error) {
    throw new Error(
      `Configured ownership label ${JSON.stringify(execution.inputs.label)} does not exist or is not accessible`,
      { cause: error },
    );
  }
}

async function observeRemoteState(
  execution: ActionExecution,
): Promise<RemoteState> {
  let sha: string | undefined;
  try {
    const response = await execution.client.rest.git.getRef({
      owner: execution.context.owner,
      repo: execution.context.repository,
      ref: `heads/${execution.inputs.updateBranch}`,
    });
    sha = response.data.object.sha;
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }

  const pulls = await execution.client.paginate(
    execution.client.rest.pulls.list,
    {
      owner: execution.context.owner,
      repo: execution.context.repository,
      state: "all",
      head: `${execution.context.owner}:${execution.inputs.updateBranch}`,
      per_page: 100,
    },
  );
  const associated = pulls.map((pull) => pullFromData(pull));
  const live = associated.filter((pull) => pull.state === "open");
  const owned = live.filter((pull) => isOwned(execution, pull));
  const exactClosedOwners =
    sha === undefined
      ? []
      : associated.filter(
          (pull) =>
            pull.state === "closed" &&
            pull.headSha === sha &&
            isOwned(execution, pull),
        );
  if (
    live.length !== owned.length ||
    owned.length > 1 ||
    (sha === undefined
      ? live.length !== 0
      : owned.length === 0
        ? exactClosedOwners.length !== 1
        : owned.length !== 1)
  ) {
    throw new Error(
      "Update branch conflicts with a branch or pull request not owned by this workflow",
    );
  }
  if (sha !== undefined && owned[0] !== undefined && owned[0].headSha !== sha) {
    throw new Error(
      "Update pull request head does not match the observed branch revision",
    );
  }
  return { sha, ownedPullRequest: owned[0] };
}

function pullFromData(data: {
  readonly number: number;
  readonly user: { readonly login?: string } | null;
  readonly body: string | null;
  readonly title: string;
  readonly head: {
    readonly ref: string;
    readonly sha: string;
    readonly repo: { readonly full_name: string } | null;
  };
  readonly base: { readonly ref: string };
  readonly state: string;
  readonly labels: readonly (string | { readonly name?: string })[];
  readonly updated_at: string;
  readonly closed_at: string | null;
}): PullRequest {
  return {
    number: data.number,
    author: data.user?.login ?? null,
    body: data.body,
    title: data.title,
    headRef: data.head.ref,
    headSha: data.head.sha,
    headRepository: data.head.repo?.full_name ?? null,
    baseRef: data.base.ref,
    state: data.state,
    labels: data.labels.map((label) =>
      typeof label === "string" ? label : (label.name ?? ""),
    ),
    updatedAt: data.updated_at,
    closedAt: data.closed_at,
  };
}

function isOwned(execution: ActionExecution, pull: PullRequest): boolean {
  return (
    pull.author === execution.context.authenticatedLogin &&
    pull.body?.includes(BODY_MARKER) === true &&
    pull.headRef === execution.inputs.updateBranch &&
    pull.headRepository?.toLowerCase() ===
      execution.context.repositoryFullName.toLowerCase() &&
    pull.baseRef === execution.context.baseBranch &&
    pull.labels.includes(execution.inputs.label)
  );
}

async function runPrek(
  binary: string,
  worktree: string,
  cooldownDays: string,
): Promise<string> {
  try {
    const result = await execFileAsync(
      binary,
      ["auto-update", "--cooldown-days", cooldownDays],
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
      `prek auto-update failed: ${sanitizeOutput(`${detail.stdout ?? ""}${detail.stderr ?? ""}${detail.message ?? ""}`, worktree)}`,
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

async function pushUpdate(
  execution: ActionExecution,
  worktree: string,
  expectedSha: string | undefined,
): Promise<void> {
  const ref = `refs/heads/${execution.inputs.updateBranch}`;
  await gitAuthenticated(execution, worktree, [
    "push",
    repositoryUrl(execution),
    `HEAD:${ref}`,
    `--force-with-lease=${ref}:${expectedSha ?? ""}`,
  ]);
}

async function closeUnneededPullRequest(
  execution: ActionExecution,
  remote: RemoteState,
): Promise<UpdateResult> {
  const pull = remote.ownedPullRequest;
  if (pull === undefined || remote.sha === undefined) {
    return { operation: "none" };
  }
  await proveBase(execution);
  const current = await proveCurrentOwnership(execution, remote);
  const response = await execution.client.rest.pulls.update({
    owner: execution.context.owner,
    repo: execution.context.repository,
    pull_number: pull.number,
    state: "closed",
  });
  const closed = pullFromData(response.data);
  if (
    !isOwned(execution, closed) ||
    closed.state !== "closed" ||
    closed.number !== current.number ||
    closed.headSha !== remote.sha ||
    closed.closedAt === null
  ) {
    throw new Error("GitHub returned an unexpected pull request after close");
  }
  try {
    await deleteBranch(execution, remote.sha);
  } catch (error) {
    const closeEtag =
      typeof response.headers?.etag === "string"
        ? response.headers.etag
        : undefined;
    const restored = await compensateClose(execution, closed, closeEtag);
    throw new Error(
      restored
        ? `Lease-protected branch deletion failed; the exact close of pull request #${pull.number} was compensated`
        : `Lease-protected branch deletion failed; pull request #${pull.number} was not reopened because its state changed after this action's close`,
      { cause: error },
    );
  }
  return { operation: "closed" };
}

async function proveBase(execution: ActionExecution): Promise<void> {
  const response = await execution.client.rest.git.getRef({
    owner: execution.context.owner,
    repo: execution.context.repository,
    ref: `heads/${execution.context.baseBranch}`,
  });
  if (response.data.object.sha !== execution.context.baseSha) {
    throw new Error("The base branch changed after checkout");
  }
}

async function proveCurrentOwnership(
  execution: ActionExecution,
  remote: RemoteState,
): Promise<PullRequest> {
  const expected = remote.ownedPullRequest;
  if (expected === undefined || remote.sha === undefined) {
    throw new Error("Expected an owned update pull request and branch");
  }
  const [pullResponse, refResponse] = await Promise.all([
    execution.client.rest.pulls.get({
      owner: execution.context.owner,
      repo: execution.context.repository,
      pull_number: expected.number,
    }),
    execution.client.rest.git.getRef({
      owner: execution.context.owner,
      repo: execution.context.repository,
      ref: `heads/${execution.inputs.updateBranch}`,
    }),
  ]);
  const current = pullFromData(pullResponse.data);
  if (
    current.number !== expected.number ||
    current.state !== "open" ||
    !isOwned(execution, current) ||
    current.headSha !== remote.sha ||
    refResponse.data.object.sha !== remote.sha
  ) {
    throw new Error(
      "Update pull request or branch changed after initial observation",
    );
  }
  return current;
}

async function provePublishedOwnership(
  execution: ActionExecution,
  remote: RemoteState,
  newSha: string,
): Promise<void> {
  await proveCurrentOwnership(execution, {
    sha: newSha,
    ownedPullRequest: remote.ownedPullRequest,
  });
}

async function compensateClose(
  execution: ActionExecution,
  closed: PullRequest,
  closeEtag: string | undefined,
): Promise<boolean> {
  if (closeEtag === undefined) {
    return false;
  }
  try {
    const [pullResponse, refResponse] = await Promise.all([
      execution.client.rest.pulls.get({
        owner: execution.context.owner,
        repo: execution.context.repository,
        pull_number: closed.number,
      }),
      execution.client.rest.git.getRef({
        owner: execution.context.owner,
        repo: execution.context.repository,
        ref: `heads/${execution.inputs.updateBranch}`,
      }),
    ]);
    const current = pullFromData(pullResponse.data);
    if (
      current.state !== "closed" ||
      !isOwned(execution, current) ||
      current.headSha !== closed.headSha ||
      current.updatedAt !== closed.updatedAt ||
      current.closedAt !== closed.closedAt ||
      pullResponse.headers.etag !== closeEtag ||
      refResponse.data.object.sha !== closed.headSha
    ) {
      return false;
    }
    const reopenedResponse = await execution.client.rest.pulls.update({
      owner: execution.context.owner,
      repo: execution.context.repository,
      pull_number: closed.number,
      state: "open",
      headers: { "If-Match": closeEtag },
    });
    const reopened = pullFromData(reopenedResponse.data);
    return (
      reopened.state === "open" &&
      isOwned(execution, reopened) &&
      reopened.headSha === closed.headSha
    );
  } catch {
    return false;
  }
}

async function applyLabel(
  execution: ActionExecution,
  pullNumber: number,
): Promise<void> {
  await execution.client.rest.issues.addLabels({
    owner: execution.context.owner,
    repo: execution.context.repository,
    issue_number: pullNumber,
    labels: [execution.inputs.label],
  });
}

async function rollbackCreatedPullRequest(
  execution: ActionExecution,
  pullNumber: number,
  pushedSha: string,
  labelError: unknown,
): Promise<never> {
  try {
    const response = await execution.client.rest.pulls.update({
      owner: execution.context.owner,
      repo: execution.context.repository,
      pull_number: pullNumber,
      state: "closed",
    });
    const closed = pullFromData(response.data);
    if (
      closed.number !== pullNumber ||
      closed.state !== "closed" ||
      closed.headSha !== pushedSha
    ) {
      throw new Error("GitHub returned an unexpected pull request after close");
    }
  } catch (closeError) {
    throw new Error(
      `Created pull request #${pullNumber}, but applying or proving its ownership failed; closing it also failed, so its branch was preserved`,
      { cause: new AggregateError([labelError, closeError]) },
    );
  }
  try {
    await deleteBranch(execution, pushedSha);
  } catch (rollbackError) {
    throw new Error(
      `Created pull request #${pullNumber} was closed after ownership setup failed, but lease-protected branch rollback also failed; the branch was preserved`,
      { cause: new AggregateError([labelError, rollbackError]) },
    );
  }
  throw new Error(
    `Applying or proving pull request ownership failed; pull request #${pullNumber} was closed and its branch was lease-rolled back`,
    { cause: labelError },
  );
}

async function rollbackNewBranch(
  execution: ActionExecution,
  pushedSha: string,
  createError: unknown,
): Promise<never> {
  try {
    await deleteBranch(execution, pushedSha);
  } catch (rollbackError) {
    throw new Error(
      "Pull request creation definitely failed, but lease-protected branch rollback failed; the branch was preserved",
      { cause: new AggregateError([createError, rollbackError]) },
    );
  }
  throw new Error(
    "Pull request creation failed; the newly pushed branch was lease-rolled back",
    { cause: createError },
  );
}

async function rollbackExistingPush(
  execution: ActionExecution,
  remote: RemoteState,
  newSha: string,
  proofError: unknown,
): Promise<never> {
  if (remote.sha === undefined) {
    throw new Error(
      "Cannot roll back an existing branch without its observed revision",
      {
        cause: proofError,
      },
    );
  }
  const ref = `refs/heads/${execution.inputs.updateBranch}`;
  try {
    await gitAuthenticated(execution, execution.context.workspace, [
      "push",
      repositoryUrl(execution),
      `${remote.sha}:${ref}`,
      `--force-with-lease=${ref}:${newSha}`,
    ]);
  } catch (rollbackError) {
    throw new Error(
      "Post-push ownership proof failed and lease rollback also failed; the pushed branch was preserved",
      { cause: new AggregateError([proofError, rollbackError]) },
    );
  }
  throw new Error(
    "Post-push ownership proof failed; the branch was lease-rolled back",
    {
      cause: proofError,
    },
  );
}

async function deleteBranch(
  execution: ActionExecution,
  expectedSha: string,
): Promise<void> {
  const ref = `refs/heads/${execution.inputs.updateBranch}`;
  await gitAuthenticated(execution, execution.context.workspace, [
    "push",
    repositoryUrl(execution),
    `:${ref}`,
    `--force-with-lease=${ref}:${expectedSha}`,
  ]);
}

function isDefiniteCreateFailure(error: unknown): boolean {
  if (
    typeof error !== "object" ||
    error === null ||
    !("status" in error) ||
    typeof (error as { status?: unknown }).status !== "number"
  ) {
    return false;
  }
  const status = (error as { status: number }).status;
  return status >= 400 && status < 500 && ![408, 409, 429].includes(status);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status: unknown }).status === 404
  );
}

async function git(
  workspace: string,
  arguments_: readonly string[],
): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    hardenedGitArguments(["-C", workspace, ...arguments_]),
    {
      encoding: "utf8",
      env: sanitizedChildEnvironment(),
    },
  );
  return stdout.trim();
}

async function gitAuthenticated(
  execution: ActionExecution,
  workspace: string,
  arguments_: readonly string[],
): Promise<string> {
  const credential = Buffer.from(
    `x-access-token:${execution.inputs.token}`,
  ).toString("base64");
  core.setSecret(credential);
  try {
    const { stdout } = await execFileAsync(
      "git",
      hardenedGitArguments([
        "-c",
        `http.${execution.context.serverUrl}/.extraheader=AUTHORIZATION: basic ${credential}`,
        "-C",
        workspace,
        ...arguments_,
      ]),
      { encoding: "utf8", env: sanitizedChildEnvironment() },
    );
    return stdout.trim();
  } catch {
    throw new Error(
      "Authenticated git operation failed; credentials were not included in output",
    );
  }
}

function repositoryUrl(execution: ActionExecution): string {
  return `${execution.context.serverUrl}/${execution.context.repositoryFullName}.git`;
}

async function gitExit(
  workspace: string,
  arguments_: readonly string[],
): Promise<number> {
  try {
    await git(workspace, arguments_);
    return 0;
  } catch (error) {
    const exit = error as { code?: number };
    if (typeof exit.code === "number") {
      return exit.code;
    }
    throw error;
  }
}

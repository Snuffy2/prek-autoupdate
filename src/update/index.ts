import * as core from "@actions/core";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import {
  PublishedPullRequestError,
  type ActionExecution,
  type UpdateResult,
} from "../contracts.js";
import { sanitizedChildEnvironment } from "../environment.js";
import {
  git,
  gitAuthenticated,
  gitExit,
  repositoryUrl,
  type DeleteRefOutcome,
} from "../git.js";
import {
  OctokitGitHubApi,
  statusOf,
  type AutoMergePull,
  type GitHubApi,
  type Payload,
} from "../github.js";
import {
  BODY_MARKER,
  isOwnedPull,
  isSameRepository,
  ownershipPolicy,
} from "../ownership.js";
import { installPrek, type PrekInstallation } from "../prek/index.js";
import { prepareWorktree } from "./worktree.js";

const execFileAsync = promisify(execFile);
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
    if (remote.ownedPullRequest !== undefined) {
      await fetchObservedUpdateCommit(execution, worktree, remote);
      await proveCurrentOwnership(api, execution, remote);
    }
    await proveBase(api, execution);
    await pushUpdate(execution, worktree, remote.sha);
    if (remote.ownedPullRequest === undefined) {
      let pullNumber: number | undefined;
      try {
        pullNumber = await api.createPull({
          head: execution.inputs.updateBranch,
          base: execution.context.baseBranch,
          title: execution.inputs.prTitle,
          body,
        });
      } catch (error) {
        let recovered: number | undefined;
        try {
          recovered = await recoverAmbiguousCreatedPull(
            api,
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
          await rollbackNewBranch(api, execution, newSha, error);
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
        await api.addLabel(pullNumber, execution.inputs.label);
        await proveCreatedOwnership(api, execution, pullNumber, newSha, body);
      } catch (error) {
        await rollbackCreatedPullRequest(
          api,
          execution,
          pullNumber,
          newSha,
          error,
        );
      }
      await enableAutoMergeForPublishedPull(
        api,
        execution,
        "created",
        pullNumber,
        newSha,
      );
      return { operation: "created", pullRequestNumber: pullNumber };
    }

    try {
      await provePublishedOwnership(api, execution, remote, newSha);
    } catch (error) {
      await rollbackExistingPush(execution, remote, newSha, error);
    }
    let pullUpdateError: unknown;
    try {
      const response = await api.updatePull(remote.ownedPullRequest.number, {
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
        await enableAutoMergeForPublishedPull(
          api,
          execution,
          "updated",
          remote.ownedPullRequest.number,
          newSha,
        );
        return {
          operation: "updated",
          pullRequestNumber: remote.ownedPullRequest.number,
        };
      }
      pullUpdateError = new Error(
        "GitHub returned an unexpected pull request after update",
      );
    } catch (error) {
      if (error instanceof PublishedPullRequestError) {
        throw error;
      }
      pullUpdateError = error;
    }
    let verified: PullRequest;
    try {
      verified = pullFromData(
        await api.getPull(remote.ownedPullRequest.number),
      );
      if (
        isExactUpdatedPull(
          execution,
          verified,
          remote.ownedPullRequest.number,
          newSha,
          body,
        )
      ) {
        await enableAutoMergeForPublishedPull(
          api,
          execution,
          "updated",
          remote.ownedPullRequest.number,
          newSha,
        );
        return {
          operation: "updated",
          pullRequestNumber: remote.ownedPullRequest.number,
        };
      }
    } catch (verificationError) {
      if (verificationError instanceof PublishedPullRequestError) {
        throw verificationError;
      }
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

async function enableAutoMergeIfRequested(
  api: GitHubApi,
  execution: ActionExecution,
  pullNumber: number,
  expectedHeadOid: string,
): Promise<void> {
  if (!execution.inputs.autoMerge) {
    return;
  }
  if (!execution.context.tokenAuthenticatedAsUser) {
    core.warning(
      "Skipping auto-merge because the configured token did not authenticate with GET /user; provide a PAT through the token input",
    );
    return;
  }
  await enablePullRequestAutoMerge(api, execution, pullNumber, expectedHeadOid);
}

async function enableAutoMergeForPublishedPull(
  api: GitHubApi,
  execution: ActionExecution,
  operation: "created" | "updated",
  pullNumber: number,
  expectedHeadOid: string,
): Promise<void> {
  try {
    await enableAutoMergeIfRequested(
      api,
      execution,
      pullNumber,
      expectedHeadOid,
    );
  } catch (error: unknown) {
    throw new PublishedPullRequestError(operation, pullNumber, error);
  }
}

/** Enable squash auto-merge only for the exact pull-request revision published. */
async function enablePullRequestAutoMerge(
  api: GitHubApi,
  execution: ActionExecution,
  pullNumber: number,
  expectedHeadOid: string,
): Promise<void> {
  const pull = await api.getAutoMergePull(pullNumber);
  if (
    pull === null ||
    !isOwnedAutoMergePull(execution, pull, pullNumber, expectedHeadOid)
  ) {
    throw new Error(
      "Pull request changed before squash auto-merge could be enabled",
    );
  }
  if (pull.mergeMethod === "SQUASH") {
    core.info(
      `Squash auto-merge is already enabled for pull request #${pullNumber}.`,
    );
    return;
  }

  const enabled = await api.enableSquashAutoMerge(pull.id, expectedHeadOid);
  let confirmed = false;
  if (enabled) {
    try {
      const completeResult = await api.getAutoMergePull(pullNumber);
      confirmed =
        completeResult?.id === pull.id &&
        isOwnedAutoMergePull(
          execution,
          completeResult,
          pullNumber,
          expectedHeadOid,
        );
    } catch {
      confirmed = false;
    }
  }
  if (!confirmed) {
    const validationError = new Error(
      "GitHub did not confirm squash auto-merge for the exact pull-request revision",
    );
    try {
      await api.disableAutoMerge(pull.id);
      core.warning(
        "Disabled an auto-merge request after pull-request ownership revalidation failed",
      );
    } catch (disableError: unknown) {
      throw new Error(
        "Auto-merge revalidation failed and GitHub did not confirm that the request was disabled",
        { cause: new AggregateError([validationError, disableError]) },
      );
    }
    throw validationError;
  }
  core.info(`Enabled squash auto-merge for pull request #${pullNumber}.`);
}

function isOwnedAutoMergePull(
  execution: ActionExecution,
  pull: AutoMergePull,
  pullNumber: number,
  expectedHeadOid: string,
): boolean {
  return (
    pull.number === pullNumber &&
    pull.state === "OPEN" &&
    pull.headSha === expectedHeadOid &&
    isOwnedPull(pull, ownershipPolicy(execution), "exact-update-branch")
  );
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
  api: GitHubApi,
  execution: ActionExecution,
  newSha: string,
  body: string,
): Promise<number | undefined> {
  const pulls = await api.listPulls("open", {
    head: `${execution.context.owner}:${execution.inputs.updateBranch}`,
    base: execution.context.baseBranch,
  });
  const matches = pulls
    .map((pull) => pullFromData(pull))
    .filter(
      (pull) =>
        pull.author === execution.context.authenticatedLogin &&
        pull.state === "open" &&
        pull.body === body &&
        pull.title === execution.inputs.prTitle &&
        pull.headRef === execution.inputs.updateBranch &&
        isSameRepository(
          pull.headRepository,
          execution.context.repositoryFullName,
        ) &&
        pull.headSha === newSha &&
        pull.baseRef === execution.context.baseBranch,
    );
  return matches.length === 1 ? matches[0]?.number : undefined;
}

async function proveCreatedOwnership(
  api: GitHubApi,
  execution: ActionExecution,
  pullNumber: number,
  newSha: string,
  body: string,
): Promise<void> {
  const pull = pullFromData(await api.getPull(pullNumber));
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
  const destination = gitRemote(execution);
  await gitAuthenticated(destination, worktree, [
    "fetch",
    "--no-tags",
    repositoryUrl(destination),
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

async function observeRemoteState(
  api: GitHubApi,
  execution: ActionExecution,
): Promise<RemoteState> {
  const sha = await api.getRefSha(`heads/${execution.inputs.updateBranch}`);
  const pulls = await api.listPulls("all", {
    head: `${execution.context.owner}:${execution.inputs.updateBranch}`,
  });
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

interface RestPull {
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
}

function pullFromData(payload: Payload): PullRequest {
  const data = payload as unknown as RestPull;
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
  return isOwnedPull(pull, ownershipPolicy(execution), "exact-update-branch");
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

async function pushUpdate(
  execution: ActionExecution,
  worktree: string,
  expectedSha: string | undefined,
): Promise<void> {
  const ref = `refs/heads/${execution.inputs.updateBranch}`;
  const destination = gitRemote(execution);
  await gitAuthenticated(destination, worktree, [
    "push",
    repositoryUrl(destination),
    `HEAD:${ref}`,
    `--force-with-lease=${ref}:${expectedSha ?? ""}`,
  ]);
}

async function closeUnneededPullRequest(
  api: GitHubApi,
  execution: ActionExecution,
  remote: RemoteState,
): Promise<UpdateResult> {
  const pull = remote.ownedPullRequest;
  if (pull === undefined || remote.sha === undefined) {
    return { operation: "none" };
  }
  await proveBase(api, execution);
  const current = await proveCurrentOwnership(api, execution, remote);
  const response = await api.updatePull(pull.number, { state: "closed" });
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
    if (
      (await deleteUpdateBranch(api, execution, remote.sha)) ===
      "already-absent"
    ) {
      throw new Error("The update branch was already absent at deletion");
    }
  } catch (error) {
    const restored = await compensateClose(
      api,
      execution,
      closed,
      response.etag,
    );
    throw new Error(
      restored
        ? `Lease-protected branch deletion failed; the exact close of pull request #${pull.number} was compensated`
        : `Lease-protected branch deletion failed; pull request #${pull.number} was not reopened because its state changed after this action's close`,
      { cause: error },
    );
  }
  return {
    operation: "closed",
    cleanup: {
      closedPullRequests: [pull.number],
      deletedBranches: [execution.inputs.updateBranch],
    },
  };
}

async function proveBase(
  api: GitHubApi,
  execution: ActionExecution,
): Promise<void> {
  const current = await api.requireRefSha(
    `heads/${execution.context.baseBranch}`,
  );
  if (current !== execution.context.baseSha) {
    throw new Error(
      `The base branch changed after checkout: ${execution.context.baseBranch} is at ${current}, but the checkout is at ${execution.context.baseSha}. For a detached or older checkout, check out the current tip of ${execution.context.baseBranch}.`,
    );
  }
}

async function proveCurrentOwnership(
  api: GitHubApi,
  execution: ActionExecution,
  remote: RemoteState,
): Promise<PullRequest> {
  const expected = remote.ownedPullRequest;
  if (expected === undefined || remote.sha === undefined) {
    throw new Error("Expected an owned update pull request and branch");
  }
  const [pull, refSha] = await Promise.all([
    api.getPull(expected.number),
    api.requireRefSha(`heads/${execution.inputs.updateBranch}`),
  ]);
  const current = pullFromData(pull);
  if (
    current.number !== expected.number ||
    current.state !== "open" ||
    !isOwned(execution, current) ||
    current.headSha !== remote.sha ||
    refSha !== remote.sha
  ) {
    throw new Error(
      "Update pull request or branch changed after initial observation",
    );
  }
  return current;
}

async function provePublishedOwnership(
  api: GitHubApi,
  execution: ActionExecution,
  remote: RemoteState,
  newSha: string,
): Promise<void> {
  await proveCurrentOwnership(api, execution, {
    sha: newSha,
    ownedPullRequest: remote.ownedPullRequest,
  });
}

async function compensateClose(
  api: GitHubApi,
  execution: ActionExecution,
  closed: PullRequest,
  closeEtag: string | undefined,
): Promise<boolean> {
  if (closeEtag === undefined) {
    return false;
  }
  try {
    const [pullResponse, refSha] = await Promise.all([
      api.getPullWithEtag(closed.number),
      api.requireRefSha(`heads/${execution.inputs.updateBranch}`),
    ]);
    const current = pullFromData(pullResponse.data);
    if (
      current.state !== "closed" ||
      !isOwned(execution, current) ||
      current.headSha !== closed.headSha ||
      current.updatedAt !== closed.updatedAt ||
      current.closedAt !== closed.closedAt ||
      pullResponse.etag !== closeEtag ||
      refSha !== closed.headSha
    ) {
      return false;
    }
    const reopenedResponse = await api.updatePull(
      closed.number,
      { state: "open" },
      closeEtag,
    );
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

async function rollbackCreatedPullRequest(
  api: GitHubApi,
  execution: ActionExecution,
  pullNumber: number,
  pushedSha: string,
  labelError: unknown,
): Promise<never> {
  try {
    const response = await api.updatePull(pullNumber, { state: "closed" });
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
  let deletion: CompletedDeletion;
  try {
    deletion = await deleteUpdateBranch(api, execution, pushedSha);
  } catch (rollbackError) {
    throw new Error(
      `Created pull request #${pullNumber} was closed after ownership setup failed, but lease-protected branch rollback also failed; the branch was preserved`,
      { cause: new AggregateError([labelError, rollbackError]) },
    );
  }
  throw new Error(
    deletion === "already-absent"
      ? `Applying or proving pull request ownership failed; pull request #${pullNumber} was closed and its branch was already absent`
      : `Applying or proving pull request ownership failed; pull request #${pullNumber} was closed and its branch was lease-rolled back`,
    { cause: labelError },
  );
}

async function rollbackNewBranch(
  api: GitHubApi,
  execution: ActionExecution,
  pushedSha: string,
  createError: unknown,
): Promise<never> {
  let deletion: CompletedDeletion;
  try {
    deletion = await deleteUpdateBranch(api, execution, pushedSha);
  } catch (rollbackError) {
    throw new Error(
      "Pull request creation definitely failed, but lease-protected branch rollback failed; the branch was preserved",
      { cause: new AggregateError([createError, rollbackError]) },
    );
  }
  throw new Error(
    deletion === "already-absent"
      ? "Pull request creation failed; the newly pushed branch was already absent"
      : "Pull request creation failed; the newly pushed branch was lease-rolled back",
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
  const destination = gitRemote(execution);
  try {
    await gitAuthenticated(destination, execution.context.workspace, [
      "push",
      repositoryUrl(destination),
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

type CompletedDeletion = Exclude<DeleteRefOutcome, "lease-rejected">;

async function deleteUpdateBranch(
  api: GitHubApi,
  execution: ActionExecution,
  expectedSha: string,
): Promise<CompletedDeletion> {
  const outcome = await api.deleteRef(
    `heads/${execution.inputs.updateBranch}`,
    expectedSha,
    execution.context.workspace,
  );
  if (outcome === "lease-rejected") {
    throw new Error(
      "Lease-protected branch deletion rejected because the branch moved",
    );
  }
  return outcome;
}

function isDefiniteCreateFailure(error: unknown): boolean {
  const status = statusOf(error);
  return (
    status !== undefined &&
    status >= 400 &&
    status < 500 &&
    ![408, 409, 429].includes(status)
  );
}

function gitRemote(execution: ActionExecution) {
  return {
    serverUrl: execution.context.serverUrl,
    token: execution.inputs.token,
    repositoryFullName: execution.context.repositoryFullName,
  };
}

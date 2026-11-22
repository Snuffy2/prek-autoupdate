import * as core from "@actions/core";

import {
  CreatedPullOwnershipError,
  PublishedPullRequestError,
  type ActionExecution,
  type UpdateResult,
} from "../contracts.js";
import {
  git,
  gitAuthenticated,
  repositoryUrl,
  type DeleteRefOutcome,
} from "../git.js";
import {
  statusOf,
  type AutoMergePull,
  type GitHubApi,
  type Payload,
} from "../github.js";
import {
  isOwnedPull,
  isSameRepository,
  ownershipPolicy,
} from "../ownership.js";
import type { DetachedWorktree } from "./worktree.js";

type PublicationContext = Pick<ActionExecution, "context" | "inputs">;

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

interface UpdateCandidate {
  readonly worktree: Pick<DetachedWorktree, "path">;
  readonly sha: string;
  readonly body: string;
}

/** Publish a prepared commit and verify its pull request before post-publication setup. */
export async function publishUpdate(
  api: GitHubApi,
  execution: PublicationContext,
  remote: RemoteState,
  { worktree, sha: newSha, body }: UpdateCandidate,
): Promise<UpdateResult> {
  const original = remote.ownedPullRequest;
  if (remote.sha !== undefined) {
    try {
      await fetchObservedUpdateCommit(execution, worktree.path, remote);
    } catch (error) {
      throw new Error(
        "Could not prove the observed update branch revision is locally available before publication",
        { cause: error },
      );
    }
  }
  if (original !== undefined) {
    await proveCurrentOwnership(api, execution, remote);
  }
  await proveBase(api, execution);
  await pushUpdate(execution, worktree.path, remote.sha);

  const operation = original === undefined ? "created" : "updated";
  let pullNumber: number;
  if (original === undefined) {
    pullNumber = await publishNewPull(
      api,
      execution,
      remote,
      worktree.path,
      newSha,
      body,
    );
  } else {
    pullNumber = original.number;
    await publishExistingPull(
      api,
      execution,
      remote,
      worktree.path,
      pullNumber,
      newSha,
      body,
    );
  }

  await enableAutoMergeForPublishedPull(
    api,
    execution,
    operation,
    pullNumber,
    newSha,
  );
  return { operation, pullRequestNumber: pullNumber };
}

async function publishNewPull(
  api: GitHubApi,
  execution: PublicationContext,
  remote: RemoteState,
  worktree: string,
  newSha: string,
  body: string,
): Promise<number> {
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
      let conflict: PullRequest | undefined;
      try {
        conflict = await findOpenPullOnUpdateBranch(api, execution);
      } catch (inspectionError) {
        throw new Error(
          "Pull request creation failed; open pull requests on the update branch could not be checked, so the branch was preserved",
          { cause: new AggregateError([error, inspectionError]) },
        );
      }
      if (conflict !== undefined) {
        throw new Error(
          `Pull request creation failed; pull request #${conflict.number} already uses update branch ${execution.inputs.updateBranch}, so the branch was preserved`,
          { cause: error },
        );
      }
      await rollbackNewBranch(api, execution, remote, worktree, newSha, error);
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
  } catch (labelError) {
    try {
      // The label may be absent, so prove the identity of the PR we just created.
      await proveCreatedOwnership(
        api,
        execution,
        pullNumber,
        newSha,
        body,
        false,
      );
    } catch (proofError) {
      throw new CreatedPullOwnershipError(
        pullNumber,
        new AggregateError(
          [labelError, proofError],
          "Label application and ownership verification failed",
          { cause: labelError },
        ),
      );
    }
    await rollbackCreatedPullRequest(
      api,
      execution,
      pullNumber,
      newSha,
      labelError,
    );
  }
  try {
    await proveCreatedOwnership(api, execution, pullNumber, newSha, body, true);
  } catch (proofError) {
    throw new CreatedPullOwnershipError(pullNumber, proofError);
  }
  return pullNumber;
}

async function findOpenPullOnUpdateBranch(
  api: GitHubApi,
  execution: PublicationContext,
): Promise<PullRequest | undefined> {
  const pulls = await api.listPulls("open", {
    head: `${execution.context.owner}:${execution.inputs.updateBranch}`,
  });
  return pulls
    .map((pull) => pullFromData(pull))
    .find(
      (pull) =>
        pull.state === "open" &&
        pull.headRef === execution.inputs.updateBranch &&
        isSameRepository(
          pull.headRepository,
          execution.context.repositoryFullName,
        ),
    );
}

async function publishExistingPull(
  api: GitHubApi,
  execution: PublicationContext,
  remote: RemoteState,
  worktree: string,
  pullNumber: number,
  newSha: string,
  body: string,
): Promise<void> {
  try {
    await provePublishedOwnership(api, execution, remote, newSha);
  } catch (error) {
    await rollbackExistingPush(execution, remote, worktree, newSha, error);
  }
  let pullUpdateError: unknown;
  try {
    const response = await api.updatePull(pullNumber, {
      title: execution.inputs.prTitle,
      body,
    });
    const updated = pullFromData(response.data);
    if (isExactUpdatedPull(execution, updated, pullNumber, newSha, body)) {
      return;
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
    verified = pullFromData(await api.getPull(pullNumber));
    if (isExactUpdatedPull(execution, verified, pullNumber, newSha, body)) {
      return;
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
      worktree,
      newSha,
      new AggregateError([pullUpdateError, verificationError]),
    );
  }
  throw new Error(
    "Pull request metadata outcome is ambiguous; the lease-protected new branch was preserved",
    { cause: new AggregateError([pullUpdateError, verificationError]) },
  );
}

async function enableAutoMergeIfRequested(
  api: GitHubApi,
  execution: PublicationContext,
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
  execution: PublicationContext,
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
  execution: PublicationContext,
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
  let observedDifferentMethod = false;
  if (enabled) {
    try {
      const completeResult = await api.getAutoMergePull(pullNumber);
      const exactPull =
        completeResult?.id === pull.id &&
        isOwnedAutoMergePull(
          execution,
          completeResult,
          pullNumber,
          expectedHeadOid,
        );
      confirmed = exactPull && completeResult?.mergeMethod === "SQUASH";
      observedDifferentMethod = exactPull && !confirmed;
    } catch {
      confirmed = false;
    }
  }
  if (!confirmed) {
    const validationError = new Error(
      "GitHub did not confirm squash auto-merge for the exact pull-request revision",
    );
    if (observedDifferentMethod) {
      throw validationError;
    }
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
  execution: PublicationContext,
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

function isExactUpdatedPull(
  execution: PublicationContext,
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
  execution: PublicationContext,
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
  execution: PublicationContext,
  newSha: string,
  body: string,
): Promise<number | undefined> {
  const pulls = await api.listPulls("open", {
    head: `${execution.context.owner}:${execution.inputs.updateBranch}`,
    base: execution.context.baseBranch,
  });
  const matches = pulls
    .map((pull) => pullFromData(pull))
    .filter((pull) => matchesCreatedPull(execution, pull, newSha, body));
  return matches.length === 1 ? matches[0]?.number : undefined;
}

function matchesCreatedPull(
  execution: PublicationContext,
  pull: PullRequest,
  newSha: string,
  body: string,
): boolean {
  return (
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
    pull.baseRef === execution.context.baseBranch
  );
}

async function proveCreatedOwnership(
  api: GitHubApi,
  execution: PublicationContext,
  pullNumber: number,
  newSha: string,
  body: string,
  requireLabel: boolean,
): Promise<void> {
  const pull = pullFromData(await api.getPull(pullNumber));
  if (
    pull.number !== pullNumber ||
    !matchesCreatedPull(execution, pull, newSha, body) ||
    (requireLabel && !isOwned(execution, pull))
  ) {
    throw new Error(
      "GitHub did not return the exact owned pull request after creation",
    );
  }
}

async function fetchObservedUpdateCommit(
  execution: PublicationContext,
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

export async function observeRemoteState(
  api: GitHubApi,
  execution: PublicationContext,
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

function isOwned(execution: PublicationContext, pull: PullRequest): boolean {
  return isOwnedPull(pull, ownershipPolicy(execution), "exact-update-branch");
}

async function pushUpdate(
  execution: PublicationContext,
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

export async function closeUnneededPullRequest(
  api: GitHubApi,
  execution: PublicationContext,
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

export async function proveBase(
  api: GitHubApi,
  execution: PublicationContext,
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
  execution: PublicationContext,
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
  execution: PublicationContext,
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
  execution: PublicationContext,
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
  execution: PublicationContext,
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
  execution: PublicationContext,
  remote: RemoteState,
  worktree: string,
  pushedSha: string,
  createError: unknown,
): Promise<never> {
  if (remote.sha !== undefined) {
    await rollbackExistingPush(
      execution,
      remote,
      worktree,
      pushedSha,
      createError,
      "Pull request creation failed",
    );
  }
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
  execution: PublicationContext,
  remote: RemoteState,
  worktree: string,
  newSha: string,
  proofError: unknown,
  failureLabel = "Post-push ownership proof failed",
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
    await gitAuthenticated(destination, worktree, [
      "push",
      repositoryUrl(destination),
      `${remote.sha}:${ref}`,
      `--force-with-lease=${ref}:${newSha}`,
    ]);
  } catch (rollbackError) {
    throw new Error(
      `${failureLabel} and lease rollback also failed; the pushed branch was preserved`,
      { cause: new AggregateError([proofError, rollbackError]) },
    );
  }
  throw new Error(`${failureLabel}; the branch was lease-rolled back`, {
    cause: proofError,
  });
}

type CompletedDeletion = Exclude<DeleteRefOutcome, "lease-rejected">;

async function deleteUpdateBranch(
  api: GitHubApi,
  execution: PublicationContext,
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

function gitRemote(execution: PublicationContext) {
  return {
    serverUrl: execution.context.serverUrl,
    token: execution.inputs.token,
    repositoryFullName: execution.context.repositoryFullName,
  };
}

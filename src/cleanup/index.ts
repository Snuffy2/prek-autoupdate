import type {
  ActionExecution,
  CleanupOptions,
  CleanupResult,
  GitHubClient,
} from "../contracts.js";
import { OctokitCleanupApi } from "./github.js";
import type {
  BranchDeletion,
  CleanupApi,
  ClosedPullCandidate,
  CompensatablePull,
  OwnershipPolicy,
  Payload,
  PullComparisonSnapshot,
} from "./model.js";
import {
  closeIdentity,
  closedDeletionIdentity,
  headRef,
  isWorkflowPull,
  pullBaseRef,
  pullChangedFiles,
  pullHeadRef,
  pullHeadSha,
  pullNumber,
  sameCandidate,
  sameRepoHeadRef,
} from "./payload.js";

const BODY_MARKER = "Automated update of `prek` hooks.";

export async function cleanupUpdateBranches(
  execution: ActionExecution,
  options: CleanupOptions,
): Promise<CleanupResult> {
  const api = new OctokitCleanupApi(
    execution.client,
    execution.context.owner,
    execution.context.repository,
    execution.inputs.token,
    execution.context.serverUrl,
  );
  return cleanupWithApi(api, execution, options);
}

export async function cleanupWithApi(
  api: CleanupApi,
  execution: Omit<ActionExecution, "client"> & {
    readonly client?: GitHubClient;
  },
  options: CleanupOptions,
): Promise<CleanupResult> {
  const result = {
    closedPullRequests: [] as number[],
    deletedBranches: [] as string[],
  };
  const policy: OwnershipPolicy = {
    repository: execution.context.repositoryFullName,
    baseBranch: execution.context.baseBranch,
    branch: execution.inputs.updateBranch,
    branchPrefix: execution.inputs.branchPrefix,
    labelName: execution.inputs.label,
    authorLogin: execution.context.authenticatedLogin,
    bodyMarker: BODY_MARKER,
  };
  const openPulls = await api.listPulls("open");
  const workflowOpen = openPulls.filter((pull) => isWorkflowPull(pull, policy));
  const workflowNumbers = new Set(workflowOpen.map(pullNumber));
  const protectedBranches = collectProtectedBranches(
    openPulls,
    workflowNumbers,
    policy.repository,
    policy.branchPrefix,
  );
  const queued = new Map<string, BranchDeletion>();
  const latest = options.keepLatestOpenPullRequest
    ? Math.max(...workflowNumbers, Number.NEGATIVE_INFINITY)
    : undefined;

  for (const pull of workflowOpen) {
    const number = pullNumber(pull);
    if (
      await closeObsolete(
        api,
        pull,
        policy,
        options.closeObsoletePullRequests,
        result,
        protectedBranches,
      )
    )
      continue;
    await handleStale(
      api,
      pull,
      number === options.keepPullRequestNumber || number === latest,
      options.closeStalePullRequests,
      policy,
      result,
      protectedBranches,
    );
  }

  if (options.deleteStaleBranches || options.deleteMergedBranches) {
    for (const pull of (await api.listPulls("closed")).filter((item) =>
      isWorkflowPull(item, policy),
    )) {
      const stale = pull.merged_at === null || pull.merged_at === undefined;
      if (!(stale ? options.deleteStaleBranches : options.deleteMergedBranches))
        continue;
      const candidate = closedDeletionIdentity(pull);
      const sha = await matchingBranchHeadSha(api, pull, policy.repository);
      if (candidate !== undefined && sha !== undefined) {
        queueDeletion(queued, protectedBranches, headRef(pull), {
          expectedSha: sha,
          candidates: [candidate],
        });
      }
    }
  }
  await deleteQueued(api, queued, protectedBranches, result, policy);
  return result;
}

function collectProtectedBranches(
  pulls: readonly Payload[],
  workflowNumbers: ReadonlySet<number>,
  repository: string,
  prefix: string,
): Set<string> {
  const result = new Set<string>();
  for (const pull of pulls) {
    const ref = sameRepoHeadRef(pull, repository);
    if (
      !workflowNumbers.has(pullNumber(pull)) &&
      ref?.startsWith(prefix) === true
    )
      result.add(ref);
  }
  return result;
}

async function handleStale(
  api: CleanupApi,
  pull: Payload,
  keep: boolean,
  enabled: boolean,
  policy: OwnershipPolicy,
  result: { closedPullRequests: number[] },
  protectedBranches: Set<string>,
): Promise<void> {
  const number = pullNumber(pull);
  const branch = headRef(pull);
  if (keep || !enabled) {
    protectedBranches.add(branch);
    return;
  }
  if (!isWorkflowPull(await api.getPull(number), policy)) {
    protectedBranches.add(branch);
    return;
  }
  const closed = await api.closePull(number);
  const identity = closeIdentity(closed);
  if (identity === undefined) {
    protectedBranches.add(branch);
    return;
  }
  if (!isWorkflowPull(closed, policy)) {
    await reopenAndProtect(
      api,
      [identity],
      branch,
      protectedBranches,
      result,
      policy,
    );
    return;
  }
  result.closedPullRequests.push(number);
  protectedBranches.add(branch);
}

function queueDeletion(
  queued: Map<string, BranchDeletion>,
  protectedBranches: Set<string>,
  branch: string,
  deletion: BranchDeletion,
): void {
  const existing = queued.get(branch);
  if (existing === undefined) {
    queued.set(branch, deletion);
  } else if (existing.expectedSha === deletion.expectedSha) {
    queued.set(branch, {
      expectedSha: existing.expectedSha,
      candidates: [...existing.candidates, ...deletion.candidates],
    });
  } else {
    protectedBranches.add(branch);
    queued.delete(branch);
  }
}

async function deleteQueued(
  api: CleanupApi,
  queued: ReadonlyMap<string, BranchDeletion>,
  protectedBranches: Set<string>,
  result: { deletedBranches: string[] },
  policy: OwnershipPolicy,
): Promise<void> {
  for (const branch of [...queued.keys()].sort()) {
    if (protectedBranches.has(branch)) continue;
    const deletion = queued.get(branch);
    if (deletion === undefined) continue;
    let owned = true;
    for (const candidate of deletion.candidates) {
      if (
        !closedPullStillOwned(
          await api.getPull(candidate.number),
          candidate,
          policy,
        )
      ) {
        owned = false;
        break;
      }
    }
    if (!owned) {
      protectedBranches.add(branch);
      continue;
    }
    if ((await api.getRefSha(`heads/${branch}`)) !== deletion.expectedSha)
      continue;
    if (
      (await api.listPulls("open")).some(
        (pull) => sameRepoHeadRef(pull, policy.repository) === branch,
      )
    ) {
      protectedBranches.add(branch);
      continue;
    }
    const outcome = await api.deleteRef(
      `heads/${branch}`,
      deletion.expectedSha,
    );
    if (outcome === "deleted") {
      try {
        const appeared = (await api.listPulls("open")).some(
          (pull) => sameRepoHeadRef(pull, policy.repository) === branch,
        );
        if (appeared) {
          await api.restoreRef(`heads/${branch}`, deletion.expectedSha);
          protectedBranches.add(branch);
          continue;
        }
        result.deletedBranches.push(branch);
      } catch (original: unknown) {
        try {
          await api.restoreRef(`heads/${branch}`, deletion.expectedSha);
        } catch (compensation: unknown) {
          throw new AggregateError(
            [original, compensation],
            "Post-delete validation and branch restoration both failed",
            { cause: compensation },
          );
        }
        throw original;
      }
    } else if (outcome === "lease-rejected") protectedBranches.add(branch);
  }
}

async function closeObsolete(
  api: CleanupApi,
  pull: Payload,
  policy: OwnershipPolicy,
  enabled: boolean,
  result: { closedPullRequests: number[] },
  protectedBranches: Set<string>,
): Promise<boolean> {
  const snapshot = enabled ? await obsoleteSnapshot(api, pull) : undefined;
  if (snapshot === undefined) return false;
  const number = pullNumber(pull);
  if (!isWorkflowPull(await api.getPull(number), policy)) {
    protectedBranches.add(snapshot.headRef);
    return true;
  }
  const closed = await api.closePull(number);
  const identity = closeIdentity(closed);
  if (identity === undefined) {
    protectedBranches.add(snapshot.headRef);
    return true;
  }
  if (!isWorkflowPull(closed, policy)) {
    await reopenAndProtect(
      api,
      [identity],
      snapshot.headRef,
      protectedBranches,
      result,
      policy,
    );
    return true;
  }
  try {
    const snapshotMatches = await pullMatchesSnapshot(
      api,
      number,
      snapshot,
      "closed",
    );
    const branchMatches =
      sameRepoHeadRef(pull, policy.repository) === snapshot.headRef &&
      (await api.getRefSha(`heads/${snapshot.headRef}`)) === snapshot.headSha;
    if (!snapshotMatches || !branchMatches) {
      await reopenAndProtect(
        api,
        [identity],
        snapshot.headRef,
        protectedBranches,
        result,
        policy,
      );
      return true;
    }
  } catch (error: unknown) {
    try {
      await reopenAndProtect(
        api,
        [identity],
        snapshot.headRef,
        protectedBranches,
        result,
        policy,
      );
    } catch (compensation: unknown) {
      throw new AggregateError(
        [error, compensation],
        "Snapshot validation and pull request compensation both failed",
        { cause: compensation },
      );
    }
    throw error;
  }
  result.closedPullRequests.push(number);
  protectedBranches.add(snapshot.headRef);
  return true;
}

async function reopenAndProtect(
  api: CleanupApi,
  pulls: readonly CompensatablePull[],
  branch: string,
  protectedBranches: Set<string>,
  result: { closedPullRequests: number[] },
  policy: OwnershipPolicy,
): Promise<void> {
  for (const identity of [...pulls].sort(
    (left, right) => left.number - right.number,
  )) {
    const index = result.closedPullRequests.indexOf(identity.number);
    if (index >= 0) result.closedPullRequests.splice(index, 1);
    let current: Payload;
    try {
      current = await api.getPull(identity.number);
    } catch (error: unknown) {
      if (isStatus(error, 404) || isStatus(error, 410)) continue;
      throw error;
    }
    if (canCompensate(current, identity, policy)) {
      const reopened = await api.reopenPull(identity.number);
      if (
        reopened.state !== "open" ||
        pullNumber(reopened) !== identity.number ||
        !isWorkflowPull(reopened, policy) ||
        pullHeadSha(reopened) !== pullHeadSha(current) ||
        pullHeadRef(reopened) !== pullHeadRef(current) ||
        pullBaseRef(reopened) !== pullBaseRef(current)
      )
        throw new TypeError("Reopen response did not match checked pull");
    }
  }
  protectedBranches.add(branch);
}

function isStatus(error: unknown, status: number): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "status" in error &&
    (error as { readonly status?: unknown }).status === status
  );
}

function canCompensate(
  pull: Payload,
  identity: CompensatablePull,
  policy: OwnershipPolicy,
): boolean {
  const current = closeIdentity(pull);
  if (current === undefined || !isWorkflowPull(pull, policy)) return false;
  return (
    sameCompensation(current, identity) ||
    (current.number === identity.number &&
      current.headRef === identity.headRef &&
      current.baseRef === identity.baseRef &&
      current.headSha !== identity.headSha &&
      current.closedAt === identity.closedAt)
  );
}

function sameCompensation(
  left: CompensatablePull,
  right: CompensatablePull,
): boolean {
  return (
    left.number === right.number &&
    left.headSha === right.headSha &&
    left.headRef === right.headRef &&
    left.baseRef === right.baseRef &&
    left.changedFiles === right.changedFiles &&
    left.updatedAt === right.updatedAt &&
    left.closedAt === right.closedAt
  );
}

async function obsoleteSnapshot(
  api: CleanupApi,
  pull: Payload,
): Promise<PullComparisonSnapshot | undefined> {
  const number = pullNumber(pull);
  const details = await api.getPull(number);
  const changedFiles = pullChangedFiles(details);
  const headSha = pullHeadSha(details);
  const ref = pullHeadRef(details);
  const baseRef = pullBaseRef(details);
  if (headSha === undefined || ref === undefined || baseRef === undefined)
    return undefined;
  const baseSha = await api.getRefSha(`heads/${baseRef}`);
  if (baseSha === undefined) return undefined;
  const snapshot = { headSha, headRef: ref, baseRef, baseSha, changedFiles };
  if (changedFiles === 0) {
    return (await pullMatchesSnapshot(api, number, snapshot))
      ? snapshot
      : undefined;
  }
  const files = await api.compareFiles(baseSha, headSha);
  if (files.length !== changedFiles) return undefined;
  const paths = pullFilePaths(files);
  const headEntries = await api.getTreeEntries(paths, headSha);
  const baseEntries = await api.getTreeEntries(paths, baseSha);
  if (
    paths.size === 0 ||
    headEntries === undefined ||
    baseEntries === undefined
  )
    return undefined;
  return mapsEqual(headEntries, baseEntries) &&
    (await pullMatchesSnapshot(api, number, snapshot))
    ? snapshot
    : undefined;
}

async function pullMatchesSnapshot(
  api: CleanupApi,
  number: number,
  snapshot: PullComparisonSnapshot,
  requiredState?: string,
): Promise<boolean> {
  const pull = await api.getPull(number);
  return (
    (requiredState === undefined || pull.state === requiredState) &&
    pullHeadSha(pull) === snapshot.headSha &&
    pullHeadRef(pull) === snapshot.headRef &&
    pullBaseRef(pull) === snapshot.baseRef &&
    pullChangedFiles(pull) === snapshot.changedFiles &&
    (await api.getRefSha(`heads/${snapshot.baseRef}`)) === snapshot.baseSha
  );
}

function pullFilePaths(files: readonly Payload[]): Set<string> {
  const paths = new Set<string>();
  for (const file of files) {
    if (typeof file.filename !== "string")
      throw new TypeError("Pull request file is missing a filename");
    paths.add(file.filename);
    if (
      file.previous_filename !== undefined &&
      file.previous_filename !== null
    ) {
      if (typeof file.previous_filename !== "string") {
        throw new TypeError(
          "Pull request file has an invalid previous filename",
        );
      }
      paths.add(file.previous_filename);
    }
  }
  return paths;
}

function mapsEqual(
  left: ReadonlyMap<string, string | undefined>,
  right: ReadonlyMap<string, string | undefined>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left)
    if (right.get(key) !== value || !right.has(key)) return false;
  return true;
}

async function matchingBranchHeadSha(
  api: CleanupApi,
  pull: Payload,
  repository: string,
): Promise<string | undefined> {
  const ref = sameRepoHeadRef(pull, repository);
  if (ref === undefined) return undefined;
  const branchSha = await api.getRefSha(`heads/${ref}`);
  const sha = pullHeadSha(pull);
  return branchSha !== undefined && branchSha === sha ? sha : undefined;
}

function closedPullStillOwned(
  pull: Payload,
  candidate: ClosedPullCandidate,
  policy: OwnershipPolicy,
): boolean {
  const current = closedDeletionIdentity(pull);
  return (
    pull.state === "closed" &&
    current !== undefined &&
    sameCandidate(current, candidate) &&
    isWorkflowPull(pull, policy)
  );
}

export type {
  BranchDeletion,
  CleanupApi,
  ClosedPullCandidate,
  CompensatablePull,
  DeleteRefOutcome,
  OwnershipPolicy,
  Payload,
  PullComparisonSnapshot,
} from "./model.js";

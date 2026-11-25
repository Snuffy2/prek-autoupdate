import type { ActionExecution, CleanupResult } from "../contracts.js";
import { ownershipPolicy, type OwnershipPolicy } from "../ownership.js";
import { OctokitGitHubApi, type GitHubApi, type Payload } from "../github.js";
import type {
  BranchDeletion,
  ClosedPullCandidate,
  CompensatablePull,
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

interface CleanupUpdateFacts {
  readonly publishedPullRequestNumber?: number;
  readonly unverifiedCreatedPullRequestNumber?: number;
}

export async function cleanupUpdateBranches(
  execution: ActionExecution,
  update: CleanupUpdateFacts,
): Promise<CleanupResult> {
  const api = new OctokitGitHubApi(
    execution.client,
    execution.context.owner,
    execution.context.repository,
    execution.inputs.token,
    execution.context.serverUrl,
  );
  return cleanupWithApi(api, execution, update);
}

export async function cleanupWithApi(
  api: GitHubApi,
  execution: Pick<ActionExecution, "context" | "inputs">,
  update: CleanupUpdateFacts,
): Promise<CleanupResult> {
  const push = execution.context.eventName === "push";
  const result = {
    closedPullRequests: [] as number[],
    deletedBranches: [] as string[],
  };
  const policy = ownershipPolicy(execution);
  const openPulls = await api.listPulls("open");
  const workflowOpen = openPulls.filter((pull) => isWorkflowPull(pull, policy));
  const workflowNumbers = new Set(workflowOpen.map(pullNumber));
  const protectedBranches = collectProtectedBranches(
    openPulls,
    workflowNumbers,
    policy.repository,
    policy.branchPrefix,
  );
  const unverifiedPull = update.unverifiedCreatedPullRequestNumber;
  if (unverifiedPull !== undefined) {
    protectedBranches.add(policy.updateBranch);
  }
  const queued = new Map<string, BranchDeletion>();
  const retainedPull = push
    ? undefined
    : (update.publishedPullRequestNumber ??
      Math.max(...workflowNumbers, Number.NEGATIVE_INFINITY));

  for (const pull of workflowOpen) {
    const number = pullNumber(pull);
    if (push) {
      await closeObsolete(api, pull, policy, result, protectedBranches);
    } else if (number === retainedPull || number === unverifiedPull) {
      protectedBranches.add(headRef(pull));
    } else {
      await closeStale(api, pull, policy, result, protectedBranches);
    }
  }

  for (const pull of (await api.listPulls("closed")).filter((item) =>
    isWorkflowPull(item, policy),
  )) {
    const candidate = closedDeletionIdentity(pull);
    const sha = await matchingBranchHeadSha(api, pull, policy.repository);
    if (candidate !== undefined && sha !== undefined) {
      queueDeletion(queued, protectedBranches, headRef(pull), {
        expectedSha: sha,
        candidates: [candidate],
      });
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

async function closeStale(
  api: GitHubApi,
  pull: Payload,
  policy: OwnershipPolicy,
  result: { closedPullRequests: number[] },
  protectedBranches: Set<string>,
): Promise<void> {
  const number = pullNumber(pull);
  const branch = headRef(pull);
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
  api: GitHubApi,
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
  api: GitHubApi,
  pull: Payload,
  policy: OwnershipPolicy,
  result: { closedPullRequests: number[] },
  protectedBranches: Set<string>,
): Promise<void> {
  const snapshot = await obsoleteSnapshot(api, pull);
  if (snapshot === undefined) {
    protectedBranches.add(headRef(pull));
    return;
  }
  const number = pullNumber(pull);
  if (!isWorkflowPull(await api.getPull(number), policy)) {
    protectedBranches.add(snapshot.headRef);
    return;
  }
  const closed = await api.closePull(number);
  const identity = closeIdentity(closed);
  if (identity === undefined) {
    protectedBranches.add(snapshot.headRef);
    return;
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
    return;
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
      return;
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
}

async function reopenAndProtect(
  api: GitHubApi,
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
    const current = await api.findPull(identity.number);
    if (current !== undefined && canCompensate(current, identity, policy)) {
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
  api: GitHubApi,
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
  api: GitHubApi,
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
  api: GitHubApi,
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

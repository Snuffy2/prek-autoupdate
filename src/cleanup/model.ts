export type Payload = Record<string, unknown>;

export interface OwnershipPolicy {
  readonly repository: string;
  readonly baseBranch: string;
  readonly branch: string;
  readonly branchPrefix: string;
  readonly labelName: string;
  readonly authorLogin: string;
  readonly bodyMarker: string;
}

export interface PullComparisonSnapshot {
  readonly headSha: string;
  readonly headRef: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly changedFiles: number;
}

export interface CompensatablePull {
  readonly number: number;
  readonly headSha: string;
  readonly headRef: string;
  readonly baseRef: string;
  readonly changedFiles: number;
  readonly updatedAt: string;
  readonly closedAt: string;
}

export interface ClosedPullCandidate {
  readonly number: number;
  readonly headRef: string;
  readonly headSha: string;
  readonly updatedAt: string;
  readonly merged: boolean;
}

export interface BranchDeletion {
  readonly expectedSha: string;
  readonly candidates: readonly ClosedPullCandidate[];
}

export type DeleteRefOutcome = "already-absent" | "deleted" | "lease-rejected";

export interface CleanupApi {
  listPulls(state: "closed" | "open"): Promise<Payload[]>;
  getPull(number: number): Promise<Payload>;
  closePull(number: number): Promise<Payload>;
  reopenPull(number: number): Promise<Payload>;
  compareFiles(baseSha: string, headSha: string): Promise<Payload[]>;
  getTreeEntries(
    paths: ReadonlySet<string>,
    ref: string,
  ): Promise<ReadonlyMap<string, string | undefined> | undefined>;
  getRefSha(ref: string): Promise<string | undefined>;
  deleteRef(ref: string, expectedSha: string): Promise<DeleteRefOutcome>;
  restoreRef(ref: string, sha: string): Promise<void>;
}

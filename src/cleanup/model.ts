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

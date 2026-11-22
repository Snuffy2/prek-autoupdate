import type { ActionExecution } from "./contracts.js";

export const BODY_MARKER = "Automated update of `prek` hooks.";

export interface OwnershipPolicy {
  readonly repository: string;
  readonly baseBranch: string;
  readonly updateBranch: string;
  readonly branchPrefix: string;
  readonly labelName: string;
  readonly authorLogin: string;
}

interface PullOwnership {
  readonly author: string | null | undefined;
  readonly body: string | null | undefined;
  readonly headRef: string | undefined;
  readonly headRepository: string | null | undefined;
  readonly baseRef: string | undefined;
  readonly labels: readonly string[];
}

type BranchRule = "exact-update-branch" | "update-branch-or-prefix";

export function ownershipPolicy({
  context,
  inputs,
}: Pick<ActionExecution, "context" | "inputs">): OwnershipPolicy {
  return {
    repository: context.repositoryFullName,
    baseBranch: context.baseBranch,
    updateBranch: inputs.updateBranch,
    branchPrefix: inputs.branchPrefix,
    labelName: inputs.label,
    authorLogin: context.authenticatedLogin,
  };
}

export function isSameRepository(
  headRepository: string | null | undefined,
  repository: string,
): boolean {
  return headRepository?.toLowerCase() === repository.toLowerCase();
}

export function isOwnedPull(
  pull: PullOwnership,
  policy: OwnershipPolicy,
  branchRule: BranchRule,
): boolean {
  return (
    pull.author === policy.authorLogin &&
    typeof pull.body === "string" &&
    pull.body.includes(BODY_MARKER) &&
    isSameRepository(pull.headRepository, policy.repository) &&
    pull.baseRef === policy.baseBranch &&
    pull.labels.includes(policy.labelName) &&
    (pull.headRef === policy.updateBranch ||
      (branchRule === "update-branch-or-prefix" &&
        pull.headRef?.startsWith(policy.branchPrefix) === true))
  );
}

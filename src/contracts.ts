import type { getOctokit } from "@actions/github";

export type GitHubClient = ReturnType<typeof getOctokit>;

export type SupportedEventName = "push" | "schedule" | "workflow_dispatch";

export interface ActionInputs {
  readonly token: string;
  readonly cooldownDays: string;
  readonly updateDay: number;
  readonly updateBranch: string;
  readonly branchPrefix: string;
  readonly label: string;
  readonly commitMessage: string;
  readonly prTitle: string;
  readonly addPaths: readonly string[];
}

export interface ActionContext {
  readonly eventName: SupportedEventName;
  readonly owner: string;
  readonly repository: string;
  readonly repositoryFullName: string;
  readonly workspace: string;
  readonly baseBranch: string;
  readonly baseSha: string;
  readonly authenticatedLogin: string;
}

export type PullRequestOperation = "closed" | "created" | "none" | "updated";

export interface UpdateResult {
  readonly pullRequestNumber?: number;
  readonly operation: PullRequestOperation;
}

export interface CleanupOptions {
  readonly keepPullRequestNumber?: number;
  readonly keepLatestOpenPullRequest: boolean;
  readonly closeStalePullRequests: boolean;
  readonly closeObsoletePullRequests: boolean;
  readonly deleteStaleBranches: boolean;
  readonly deleteMergedBranches: boolean;
}

export interface CleanupResult {
  readonly closedPullRequests: readonly number[];
  readonly deletedBranches: readonly string[];
}

export interface ActionExecution {
  readonly client: GitHubClient;
  readonly context: ActionContext;
  readonly inputs: ActionInputs;
}

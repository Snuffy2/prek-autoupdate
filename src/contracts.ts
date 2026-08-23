import type { getOctokit } from "@actions/github";

export type GitHubClient = ReturnType<typeof getOctokit>;

export type SupportedEventName = "push" | "schedule" | "workflow_dispatch";

export interface ActionInputs {
  readonly token: string;
  readonly autoMerge: boolean;
  readonly authorLogin: string;
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
  readonly serverUrl: string;
  readonly workspace: string;
  readonly baseBranch: string;
  readonly baseSha: string;
  readonly authenticatedLogin: string;
  readonly tokenAuthenticatedAsUser: boolean;
}

export type PullRequestOperation = "closed" | "created" | "none" | "updated";

export interface UpdateResult {
  readonly pullRequestNumber?: number;
  readonly operation: PullRequestOperation;
}

/** Failure after a pull request was safely published and must survive cleanup. */
export class PublishedPullRequestError extends Error {
  readonly publishedPullRequest: UpdateResult;

  constructor(
    operation: "created" | "updated",
    pullRequestNumber: number,
    cause: unknown,
  ) {
    super(
      `Pull request #${pullRequestNumber} was ${operation}, but post-publication setup failed: ${String(cause)}`,
      { cause },
    );
    this.name = "PublishedPullRequestError";
    this.publishedPullRequest = { operation, pullRequestNumber };
  }
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

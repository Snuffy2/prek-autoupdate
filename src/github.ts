import type { GitHubClient } from "./contracts.js";
import { deleteBranch, type DeleteRefOutcome } from "./git.js";

export type Payload = Record<string, unknown>;

export interface PullListing {
  readonly head?: string;
  readonly base?: string;
}

export interface PullMetadata {
  readonly title: string;
  readonly body: string;
}

export interface NewPull extends PullMetadata {
  readonly head: string;
  readonly base: string;
}

export interface PullResponse {
  readonly data: Payload;
  readonly etag: string | undefined;
}

export interface AutoMergePull {
  readonly id: string;
  readonly number: number;
  readonly state: string;
  readonly headSha: string;
  readonly author: string | undefined;
  readonly body: string;
  readonly headRef: string;
  readonly headRepository: string | undefined;
  readonly baseRef: string;
  readonly labels: readonly string[];
  readonly mergeMethod: string | undefined;
}

interface AutoMergePullPage {
  readonly author: { readonly login: string } | null;
  readonly baseRefName: string;
  readonly body: string;
  readonly headRefName: string;
  readonly headRepository: { readonly nameWithOwner: string } | null;
  readonly id: string;
  readonly headRefOid: string;
  readonly labels: {
    readonly nodes: readonly { readonly name: string }[];
    readonly pageInfo: {
      readonly hasNextPage: boolean;
      readonly endCursor: string | null;
    };
  };
  readonly number: number;
  readonly state: string;
  readonly autoMergeRequest: {
    readonly enabledAt: string;
    readonly mergeMethod: string;
  } | null;
}

interface AutoMergeQueryResult {
  readonly repository: {
    readonly pullRequest: AutoMergePullPage | null;
  } | null;
}

interface AutoMergeMutationResult {
  readonly enablePullRequestAutoMerge: {
    readonly pullRequest: {
      readonly id: string;
      readonly autoMergeRequest: {
        readonly enabledAt: string;
        readonly mergeMethod: string;
      } | null;
    } | null;
  } | null;
}

interface AutoMergeDisableMutationResult {
  readonly disablePullRequestAutoMerge: {
    readonly pullRequest: Pick<
      AutoMergePullPage,
      "autoMergeRequest" | "id"
    > | null;
  } | null;
}

const AUTO_MERGE_PULL_REQUEST_QUERY = `query PrekAutoupdatePullRequest($owner: String!, $repository: String!, $number: Int!, $labelsCursor: String) {
  repository(owner: $owner, name: $repository) {
    pullRequest(number: $number) {
      id
      number
      author { login }
      baseRefName
      body
      headRefName
      headRefOid
      headRepository { nameWithOwner }
      labels(first: 100, after: $labelsCursor) {
        nodes { name }
        pageInfo { hasNextPage endCursor }
      }
      state
      autoMergeRequest { enabledAt mergeMethod }
    }
  }
}`;

export interface GitHubApi {
  listPulls(
    state: "closed" | "open" | "all",
    filters?: PullListing,
  ): Promise<Payload[]>;
  createPull(pull: NewPull): Promise<number>;
  getPullWithEtag(number: number): Promise<PullResponse>;
  updatePull(
    number: number,
    changes: PullMetadata | { readonly state: "open" | "closed" },
    ifMatch?: string,
  ): Promise<PullResponse>;
  ensureLabel(name: string): Promise<void>;
  addLabel(number: number, name: string): Promise<void>;
  getPull(number: number): Promise<Payload>;
  findPull(number: number): Promise<Payload | undefined>;
  closePull(number: number): Promise<Payload>;
  reopenPull(number: number): Promise<Payload>;
  getAutoMergePull(number: number): Promise<AutoMergePull | null>;
  /** Report whether GitHub confirmed the mutation for this pull. */
  enableSquashAutoMerge(id: string, expectedHeadOid: string): Promise<boolean>;
  disableAutoMerge(id: string): Promise<void>;
  compareFiles(baseSha: string, headSha: string): Promise<Payload[]>;
  getTreeEntries(
    paths: ReadonlySet<string>,
    ref: string,
  ): Promise<ReadonlyMap<string, string | undefined> | undefined>;
  getRefSha(ref: string): Promise<string | undefined>;
  requireRefSha(ref: string): Promise<string>;
  deleteRef(
    ref: string,
    expectedSha: string,
    workspace?: string,
  ): Promise<DeleteRefOutcome>;
  restoreRef(ref: string, sha: string): Promise<void>;
}

export class OctokitGitHubApi implements GitHubApi {
  public constructor(
    private readonly client: GitHubClient,
    private readonly owner: string,
    private readonly repo: string,
    private readonly token: string,
    private readonly serverUrl: string,
  ) {}

  public async listPulls(
    state: "closed" | "open" | "all",
    filters?: PullListing,
  ): Promise<Payload[]> {
    const pulls: Payload[] = [];
    for await (const response of this.client.paginate.iterator(
      this.client.rest.pulls.list,
      {
        owner: this.owner,
        repo: this.repo,
        state,
        ...filters,
        per_page: 100,
      },
    )) {
      for (const item of response.data)
        pulls.push(payload(item, "pull request object"));
    }
    return pulls;
  }

  public async createPull(pull: NewPull): Promise<number> {
    const response = await this.client.rest.pulls.create({
      owner: this.owner,
      repo: this.repo,
      ...pull,
    });
    return response.data.number;
  }

  public async getPullWithEtag(number: number): Promise<PullResponse> {
    const response = await this.client.rest.pulls.get({
      owner: this.owner,
      repo: this.repo,
      pull_number: number,
    });
    return pullResponse(response);
  }

  public async updatePull(
    number: number,
    changes: PullMetadata | { readonly state: "open" | "closed" },
    ifMatch?: string,
  ): Promise<PullResponse> {
    const response = await this.client.rest.pulls.update({
      owner: this.owner,
      repo: this.repo,
      pull_number: number,
      ...changes,
      ...(ifMatch === undefined ? {} : { headers: { "If-Match": ifMatch } }),
    });
    return pullResponse(response);
  }

  public async ensureLabel(name: string): Promise<void> {
    const label = { owner: this.owner, repo: this.repo, name };
    await ensureLabelExists(
      () => this.client.rest.issues.getLabel(label),
      () => this.client.rest.issues.createLabel({ ...label, color: "0366d6" }),
    );
  }

  public async addLabel(number: number, name: string): Promise<void> {
    await this.client.rest.issues.addLabels({
      owner: this.owner,
      repo: this.repo,
      issue_number: number,
      labels: [name],
    });
  }

  public async getPull(number: number): Promise<Payload> {
    return (await this.getPullWithEtag(number)).data;
  }

  public async findPull(number: number): Promise<Payload | undefined> {
    try {
      return await this.getPull(number);
    } catch (error: unknown) {
      if (isStatus(error, 404) || isStatus(error, 410)) return undefined;
      throw error;
    }
  }

  public async closePull(number: number): Promise<Payload> {
    return (await this.updatePull(number, { state: "closed" })).data;
  }

  public async reopenPull(number: number): Promise<Payload> {
    await this.client.rest.pulls.update({
      owner: this.owner,
      repo: this.repo,
      pull_number: number,
      state: "open",
    });
    const reopened = await this.getPull(number);
    if (reopened.number !== number || reopened.state !== "open")
      throw new TypeError("Reopen response did not match requested pull");
    return reopened;
  }

  public async getAutoMergePull(number: number): Promise<AutoMergePull | null> {
    const first = await this.getAutoMergePullPage(number, null);
    if (first === null) return null;

    const labels = first.labels.nodes.map((label) => label.name);
    let current = first;
    const seenCursors = new Set<string>();
    while (current.labels.pageInfo.hasNextPage) {
      const cursor = current.labels.pageInfo.endCursor;
      if (cursor === null || seenCursors.has(cursor)) {
        throw new Error(
          "GitHub returned an invalid pull-request label pagination cursor",
        );
      }
      seenCursors.add(cursor);
      const next = await this.getAutoMergePullPage(number, cursor);
      if (next === null || !sameAutoMergePullMetadata(first, next)) {
        throw new Error(
          "Pull request metadata changed while reading ownership labels",
        );
      }
      labels.push(...next.labels.nodes.map((label) => label.name));
      current = next;
    }
    return {
      id: first.id,
      number: first.number,
      state: first.state,
      headSha: first.headRefOid,
      author: first.author?.login,
      body: first.body,
      headRef: first.headRefName,
      headRepository: first.headRepository?.nameWithOwner,
      baseRef: first.baseRefName,
      labels,
      mergeMethod: first.autoMergeRequest?.mergeMethod,
    };
  }

  public async enableSquashAutoMerge(
    id: string,
    expectedHeadOid: string,
  ): Promise<boolean> {
    const enabled = await this.client.graphql<AutoMergeMutationResult>(
      `mutation EnablePrekAutoupdateAutoMerge($pullRequestId: ID!, $expectedHeadOid: GitObjectID!) {
      enablePullRequestAutoMerge(input: {
        pullRequestId: $pullRequestId
        mergeMethod: SQUASH
        expectedHeadOid: $expectedHeadOid
      }) {
        pullRequest {
          id
          autoMergeRequest { enabledAt mergeMethod }
        }
      }
    }`,
      { pullRequestId: id, expectedHeadOid },
    );
    const result = enabled?.enablePullRequestAutoMerge?.pullRequest;
    return (
      result?.id === id && result.autoMergeRequest?.mergeMethod === "SQUASH"
    );
  }

  public async disableAutoMerge(pullRequestId: string): Promise<void> {
    const disabled = await this.client.graphql<AutoMergeDisableMutationResult>(
      `mutation DisableUnverifiedPrekAutoupdateAutoMerge($pullRequestId: ID!) {
        disablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId }) {
          pullRequest {
            id
            autoMergeRequest { enabledAt mergeMethod }
          }
        }
      }`,
      { pullRequestId },
    );
    const result = disabled.disablePullRequestAutoMerge?.pullRequest;
    if (result?.id !== pullRequestId || result.autoMergeRequest !== null) {
      throw new Error("GitHub did not confirm that auto-merge was disabled");
    }
  }

  private async getAutoMergePullPage(
    number: number,
    labelsCursor: string | null,
  ): Promise<AutoMergePullPage | null> {
    const observed = await this.client.graphql<AutoMergeQueryResult>(
      AUTO_MERGE_PULL_REQUEST_QUERY,
      { owner: this.owner, repository: this.repo, number, labelsCursor },
    );
    const pull = observed.repository?.pullRequest ?? null;
    if (pull !== null) assertCompleteAutoMergePullPage(pull);
    return pull;
  }

  public async compareFiles(
    baseSha: string,
    headSha: string,
  ): Promise<Payload[]> {
    let data: Payload | undefined;
    let finalCommit: Payload | undefined;
    for await (const response of this.client.paginate.iterator(
      this.client.rest.repos.compareCommitsWithBasehead,
      {
        owner: this.owner,
        repo: this.repo,
        basehead: `${baseSha}...${headSha}`,
        per_page: 100,
      },
    )) {
      const page = payload(response.data, "comparison object");
      data ??= page;
      if (!Array.isArray(page.commits) || page.commits.length === 0)
        throw new TypeError(
          "Comparison response did not match immutable revisions",
        );
      finalCommit = payload(page.commits.at(-1), "comparison head commit");
    }
    if (data === undefined) throw new TypeError("Expected comparison response");
    const base = payload(data.base_commit, "comparison base commit");
    const commits = data.commits;
    if (
      base.sha !== baseSha ||
      !Array.isArray(commits) ||
      finalCommit?.sha !== headSha
    ) {
      throw new TypeError(
        "Comparison response did not match immutable revisions",
      );
    }
    if (!Array.isArray(data.files))
      throw new TypeError("Expected comparison file list");
    const changedFiles = data.changed_files;
    if (
      data.files.length === 300 &&
      (typeof changedFiles !== "number" ||
        !Number.isInteger(changedFiles) ||
        changedFiles < 0 ||
        changedFiles > data.files.length)
    )
      throw new TypeError(
        "Comparison file list exceeded GitHub's 300-file limit",
      );
    return data.files.map((file) => payload(file, "comparison file"));
  }

  public async getTreeEntries(
    paths: ReadonlySet<string>,
    ref: string,
  ): Promise<ReadonlyMap<string, string | undefined> | undefined> {
    const response = await this.client.rest.git.getTree({
      owner: this.owner,
      repo: this.repo,
      tree_sha: ref,
      recursive: "1",
    });
    const data = payload(response.data, "Git tree object");
    if (typeof data.truncated !== "boolean")
      throw new TypeError("Expected Git tree truncated flag");
    if (data.truncated) return undefined;
    if (!Array.isArray(data.tree))
      throw new TypeError("Expected Git tree list");
    const entries = new Map<string, string | undefined>();
    for (const path of paths) entries.set(path, undefined);
    for (const raw of data.tree) {
      const item = payload(raw, "Git tree entry");
      if (typeof item.path !== "string" || !paths.has(item.path)) continue;
      if (
        typeof item.mode !== "string" ||
        typeof item.type !== "string" ||
        typeof item.sha !== "string"
      ) {
        throw new TypeError("Expected a complete Git tree entry");
      }
      entries.set(item.path, `${item.mode}\0${item.type}\0${item.sha}`);
    }
    return entries;
  }

  public async getRefSha(ref: string): Promise<string | undefined> {
    try {
      return await this.requireRefSha(ref);
    } catch (error: unknown) {
      if (isStatus(error, 404)) return undefined;
      throw error;
    }
  }

  public async requireRefSha(ref: string): Promise<string> {
    const response = await this.client.rest.git.getRef({
      owner: this.owner,
      repo: this.repo,
      ref,
    });
    if (typeof response.data.object.sha !== "string")
      throw new TypeError("Expected ref object SHA");
    return response.data.object.sha;
  }

  public async deleteRef(
    ref: string,
    expectedSha: string,
    workspace?: string,
  ): Promise<DeleteRefOutcome> {
    return await deleteBranch({
      remote: {
        serverUrl: this.serverUrl,
        token: this.token,
        repositoryFullName: `${this.owner}/${this.repo}`,
      },
      ref: `refs/${ref}`,
      expectedSha,
      readRef: () => this.getRefSha(ref),
      ...(workspace === undefined ? {} : { workspace }),
    });
  }

  public async restoreRef(ref: string, sha: string): Promise<void> {
    try {
      await this.client.rest.git.createRef({
        owner: this.owner,
        repo: this.repo,
        ref: `refs/${ref}`,
        sha,
      });
    } catch (error: unknown) {
      if (isStatus(error, 422) && (await this.getRefSha(ref)) !== undefined)
        return;
      throw error;
    }
  }
}

function assertCompleteAutoMergePullPage(pull: AutoMergePullPage): void {
  const labels = (pull as unknown as { readonly labels?: unknown }).labels;
  if (typeof labels !== "object" || labels === null) {
    throw new Error("GitHub returned a pull request without labels");
  }
  const labelPage = labels as {
    readonly nodes?: unknown;
    readonly pageInfo?: unknown;
  };
  if (
    !Array.isArray(labelPage.nodes) ||
    !labelPage.nodes.every(
      (label: unknown) =>
        typeof label === "object" &&
        label !== null &&
        typeof (label as { readonly name?: unknown }).name === "string",
    )
  ) {
    throw new Error("GitHub returned malformed pull-request labels");
  }
  if (typeof labelPage.pageInfo !== "object" || labelPage.pageInfo === null) {
    throw new Error(
      "GitHub returned a pull request without label pagination information",
    );
  }
  const pageInfo = labelPage.pageInfo as {
    readonly hasNextPage?: unknown;
    readonly endCursor?: unknown;
  };
  if (
    typeof pageInfo.hasNextPage !== "boolean" ||
    (pageInfo.endCursor !== null && typeof pageInfo.endCursor !== "string")
  ) {
    throw new Error("GitHub returned malformed label pagination information");
  }
}

function sameAutoMergePullMetadata(
  left: AutoMergePullPage,
  right: AutoMergePullPage,
): boolean {
  return (
    left.id === right.id &&
    left.number === right.number &&
    left.author?.login === right.author?.login &&
    left.baseRefName === right.baseRefName &&
    left.body === right.body &&
    left.headRefName === right.headRefName &&
    left.headRefOid === right.headRefOid &&
    left.headRepository?.nameWithOwner ===
      right.headRepository?.nameWithOwner &&
    left.state === right.state &&
    left.autoMergeRequest?.enabledAt === right.autoMergeRequest?.enabledAt &&
    left.autoMergeRequest?.mergeMethod === right.autoMergeRequest?.mergeMethod
  );
}

export async function ensureLabelExists(
  lookup: () => Promise<unknown>,
  create: () => Promise<unknown>,
): Promise<void> {
  try {
    await lookup();
    return;
  } catch (error) {
    if (!isStatus(error, 404)) throw error;
  }
  try {
    await create();
  } catch (error) {
    if (isStatus(error, 422)) {
      // A concurrent run may have created the label after our lookup.
      try {
        await lookup();
        return;
      } catch {
        // Preserve the creation failure unless the label now exists.
      }
    }
    throw error;
  }
}

function pullResponse(response: {
  readonly data: unknown;
  readonly headers?: { readonly etag?: unknown };
}): PullResponse {
  return {
    data: payload(response.data, "pull request object"),
    etag:
      typeof response.headers?.etag === "string"
        ? response.headers.etag
        : undefined,
  };
}

function isStatus(error: unknown, status: number): boolean {
  return statusOf(error) === status;
}

export function statusOf(error: unknown): number | undefined {
  if (error === null || typeof error !== "object" || !("status" in error))
    return undefined;
  return typeof error.status === "number" ? error.status : undefined;
}

export function payload(value: unknown, description: string): Payload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Expected ${description}`);
  }
  return value as Payload;
}

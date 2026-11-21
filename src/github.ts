import type { GitHubClient } from "./contracts.js";
import { deleteBranch, type DeleteRefOutcome } from "./git.js";

export type Payload = Record<string, unknown>;

export interface GitHubApi {
  listPulls(state: "closed" | "open"): Promise<Payload[]>;
  getPull(number: number): Promise<Payload>;
  findPull(number: number): Promise<Payload | undefined>;
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

export class OctokitGitHubApi implements GitHubApi {
  public constructor(
    private readonly client: GitHubClient,
    private readonly owner: string,
    private readonly repo: string,
    private readonly token: string,
    private readonly serverUrl: string,
  ) {}

  public async listPulls(state: "closed" | "open"): Promise<Payload[]> {
    const pulls: Payload[] = [];
    for await (const response of this.client.paginate.iterator(
      this.client.rest.pulls.list,
      {
        owner: this.owner,
        repo: this.repo,
        state,
        per_page: 100,
      },
    )) {
      for (const item of response.data)
        pulls.push(payload(item, "pull request object"));
    }
    return pulls;
  }

  public async getPull(number: number): Promise<Payload> {
    const response = await this.client.rest.pulls.get({
      owner: this.owner,
      repo: this.repo,
      pull_number: number,
    });
    return payload(response.data, "pull request object");
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
    const response = await this.client.rest.pulls.update({
      owner: this.owner,
      repo: this.repo,
      pull_number: number,
      state: "closed",
    });
    return payload(response.data, "pull request object");
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
      const response = await this.client.rest.git.getRef({
        owner: this.owner,
        repo: this.repo,
        ref,
      });
      if (typeof response.data.object.sha !== "string")
        throw new TypeError("Expected ref object SHA");
      return response.data.object.sha;
    } catch (error: unknown) {
      if (isStatus(error, 404)) return undefined;
      throw error;
    }
  }

  public async deleteRef(
    ref: string,
    expectedSha: string,
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

function isStatus(error: unknown, status: number): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "status" in error &&
    (error as { readonly status?: unknown }).status === status
  );
}

export function payload(value: unknown, description: string): Payload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Expected ${description}`);
  }
  return value as Payload;
}

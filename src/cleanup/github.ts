import * as core from "@actions/core";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { GitHubClient } from "../contracts.js";
import {
  hardenedGitArguments,
  sanitizedChildEnvironment,
} from "../environment.js";
import type { CleanupApi, DeleteRefOutcome, Payload } from "./model.js";
import { payload } from "./payload.js";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;

export class OctokitCleanupApi implements CleanupApi {
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
    const fullRef = `refs/${ref}`;
    const credential = Buffer.from(`x-access-token:${this.token}`).toString(
      "base64",
    );
    core.setSecret(credential);
    const environment = sanitizedChildEnvironment();
    const directory = await mkdtemp(join(tmpdir(), "prek-autoupdate-git-"));
    try {
      await execFileAsync(
        "git",
        hardenedGitArguments(["init", "--quiet", directory]),
        {
          env: environment,
          timeout: GIT_TIMEOUT_MS,
        },
      );
      try {
        await execFileAsync(
          "git",
          hardenedGitArguments([
            "-C",
            directory,
            "-c",
            `http.${this.serverUrl}/.extraheader=AUTHORIZATION: basic ${credential}`,
            "push",
            `${this.serverUrl}/${this.owner}/${this.repo}.git`,
            `--force-with-lease=${fullRef}:${expectedSha}`,
            `:${fullRef}`,
          ]),
          { env: environment, timeout: GIT_TIMEOUT_MS },
        );
        return "deleted";
      } catch (error: unknown) {
        const current = await this.getRefSha(ref);
        if (current === undefined) return "already-absent";
        if (current !== expectedSha) return "lease-rejected";
        throw new Error(
          "Lease-protected branch deletion failed; credentials were not included in output",
          { cause: error },
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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

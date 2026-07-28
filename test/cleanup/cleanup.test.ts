import { describe, expect, it } from "vitest";

import type { ActionExecution, CleanupOptions } from "../../src/contracts.js";
import {
  cleanupWithApi,
  type CleanupApi,
  type DeleteRefOutcome,
  type Payload,
} from "../../src/cleanup/index.js";

const branch = "prek-autoupdate";
const repository = "owner/repo";
const marker = "Automated update of `prek` hooks.";

function pull(overrides: Payload = {}): Payload {
  return {
    number: 1,
    state: "open",
    merged_at: null,
    changed_files: 1,
    updated_at: "2026-01-01T00:00:00Z",
    closed_at: null,
    body: marker,
    labels: [{ name: "dependencies" }],
    user: { login: "github-actions[bot]" },
    head: { ref: branch, sha: "head", repo: { full_name: repository } },
    base: { ref: "main" },
    ...overrides,
  };
}

function closed(overrides: Payload = {}): Payload {
  return pull({
    state: "closed",
    updated_at: "2026-01-01T00:01:00Z",
    closed_at: "2026-01-01T00:01:00Z",
    ...overrides,
  });
}

const execution = {
  context: {
    eventName: "schedule",
    owner: "owner",
    repository: "repo",
    repositoryFullName: repository,
    workspace: "/workspace",
    baseBranch: "main",
    baseSha: "base",
    authenticatedLogin: "github-actions[bot]",
  },
  inputs: {
    token: "token",
    cooldownDays: "7",
    updateDay: 1,
    updateBranch: branch,
    branchPrefix: "prek-autoupdate",
    label: "dependencies",
    commitMessage: "update",
    prTitle: "update",
    addPaths: [],
  },
} as unknown as ActionExecution;

const defaults: CleanupOptions = {
  keepLatestOpenPullRequest: false,
  closeStalePullRequests: true,
  closeObsoletePullRequests: false,
  deleteStaleBranches: true,
  deleteMergedBranches: true,
};

class FakeApi implements CleanupApi {
  public open: Payload[] = [];
  public closed: Payload[] = [];
  public details = new Map<number, Payload[]>();
  public refs = new Map<string, string>();
  public refValues = new Map<string, Array<string | undefined>>();
  public comparisons: Payload[] = [];
  public trees = new Map<
    string,
    ReadonlyMap<string, string | undefined> | undefined
  >();
  public closedNumbers: number[] = [];
  public reopenedNumbers: number[] = [];
  public deleted: Array<[string, string]> = [];
  public deleteOutcome: DeleteRefOutcome = "deleted";
  public listOpenValues: Payload[][] = [];
  public reopenError?: Error;
  private versionedPull?: Payload;

  async listPulls(state: "closed" | "open"): Promise<Payload[]> {
    if (state === "open" && this.listOpenValues.length > 0)
      return this.listOpenValues.shift()!;
    return state === "open" ? this.open : this.closed;
  }
  async getPull(number: number): Promise<Payload> {
    const values = this.details.get(number);
    if (values === undefined || values.length === 0)
      throw new Error(`No detail for ${number}`);
    return values.length === 1 ? values[0]! : values.shift()!;
  }
  async closePull(number: number): Promise<Payload> {
    this.closedNumbers.push(number);
    const values = this.details.get(number);
    if (values === undefined || values.length === 0)
      throw new Error(`No close for ${number}`);
    return values.length === 1 ? values[0]! : values.shift()!;
  }
  async getVersionedPull(number: number) {
    const checked = await this.getPull(number);
    this.versionedPull = checked;
    return { pull: checked, etag: `"${number}"` };
  }
  async reopenPull(number: number): Promise<Payload> {
    if (this.reopenError !== undefined) throw this.reopenError;
    this.reopenedNumbers.push(number);
    return { ...this.versionedPull, number, state: "open" };
  }
  async compareFiles(): Promise<Payload[]> {
    return this.comparisons;
  }
  async getTreeEntries(
    _paths: ReadonlySet<string>,
    ref: string,
  ): Promise<ReadonlyMap<string, string | undefined> | undefined> {
    return this.trees.get(ref);
  }
  async getRefSha(ref: string): Promise<string | undefined> {
    const values = this.refValues.get(ref);
    if (values !== undefined && values.length > 0) return values.shift();
    return this.refs.get(ref);
  }
  async deleteRef(ref: string, expected: string): Promise<DeleteRefOutcome> {
    this.deleted.push([ref, expected]);
    return this.deleteOutcome;
  }
  async restoreRef(ref: string, sha: string): Promise<void> {
    this.refs.set(ref, sha);
  }
}

describe("cleanupUpdateBranches safety behavior", () => {
  it("closes a stale owned pull only after ownership refresh", async () => {
    const api = new FakeApi();
    api.open = [pull()];
    api.details.set(1, [pull(), closed()]);
    const result = await cleanupWithApi(api, execution, defaults);
    expect(result.closedPullRequests).toEqual([1]);
    expect(api.closedNumbers).toEqual([1]);
  });

  it("fails closed when refreshed ownership is lost", async () => {
    const api = new FakeApi();
    api.open = [pull()];
    api.details.set(1, [pull({ labels: [] })]);
    const result = await cleanupWithApi(api, execution, defaults);
    expect(result.closedPullRequests).toEqual([]);
    expect(api.closedNumbers).toEqual([]);
  });

  it("requires authenticated author, marker, label, same repo, and prefix", async () => {
    const api = new FakeApi();
    api.open = [
      pull({ number: 1, user: { login: "other" } }),
      pull({ number: 2, body: "other" }),
      pull({ number: 3, labels: [] }),
      pull({
        number: 4,
        head: { ref: branch, sha: "head", repo: { full_name: "fork/repo" } },
      }),
      pull({
        number: 5,
        head: { ref: "unowned", sha: "head", repo: { full_name: repository } },
      }),
    ];
    const result = await cleanupWithApi(api, execution, defaults);
    expect(result).toEqual({ closedPullRequests: [], deletedBranches: [] });
  });

  it("does not delete a closed branch whose current SHA differs", async () => {
    const api = new FakeApi();
    api.closed = [closed()];
    api.refs.set(`heads/${branch}`, "moved");
    const result = await cleanupWithApi(api, execution, defaults);
    expect(result.deletedBranches).toEqual([]);
    expect(api.deleted).toEqual([]);
  });

  it("revalidates exact closed evidence and shared open branches before deletion", async () => {
    const api = new FakeApi();
    const candidate = closed();
    api.closed = [candidate];
    api.open = [pull({ number: 9, labels: [], user: { login: "human" } })];
    api.refs.set(`heads/${branch}`, "head");
    api.details.set(1, [candidate]);
    const result = await cleanupWithApi(api, execution, defaults);
    expect(result.deletedBranches).toEqual([]);
    expect(api.deleted).toEqual([]);
  });

  it("deletes with the exact queued SHA after all evidence remains stable", async () => {
    const api = new FakeApi();
    const candidate = closed();
    api.closed = [candidate];
    api.refs.set(`heads/${branch}`, "head");
    api.details.set(1, [candidate]);
    const result = await cleanupWithApi(api, execution, defaults);
    expect(result.deletedBranches).toEqual([branch]);
    expect(api.deleted).toEqual([[`heads/${branch}`, "head"]]);
  });

  it("fails closed on conflicting SHA evidence for a reused branch", async () => {
    const api = new FakeApi();
    api.closed = [
      closed({ number: 1 }),
      closed({
        number: 2,
        head: { ref: branch, sha: "other", repo: { full_name: repository } },
      }),
    ];
    api.refValues.set(`heads/${branch}`, ["head", "other"]);
    const result = await cleanupWithApi(api, execution, defaults);
    expect(result.deletedBranches).toEqual([]);
  });

  it("closes a zero-change obsolete pull only while snapshot stays immutable", async () => {
    const api = new FakeApi();
    const options = { ...defaults, closeObsoletePullRequests: true };
    api.open = [pull({ changed_files: 0 })];
    api.refs.set("heads/main", "base");
    api.refs.set(`heads/${branch}`, "head");
    api.details.set(1, [
      pull({ changed_files: 0 }),
      pull({ changed_files: 0 }),
      pull({ changed_files: 0 }),
      closed({ changed_files: 0 }),
      closed({ changed_files: 0 }),
    ]);
    const result = await cleanupWithApi(api, execution, options);
    expect(result.closedPullRequests).toEqual([1]);
  });

  it("compensates only the exact close event including closed_at", async () => {
    const api = new FakeApi();
    const options = { ...defaults, closeObsoletePullRequests: true };
    api.open = [pull({ changed_files: 0 })];
    api.refs.set("heads/main", "base");
    api.refs.set(`heads/${branch}`, "moved");
    api.details.set(1, [
      pull({ changed_files: 0 }),
      pull({ changed_files: 0 }),
      pull({ changed_files: 0 }),
      closed({ changed_files: 0 }),
      closed({ changed_files: 0 }),
      closed({ changed_files: 0 }),
    ]);
    await cleanupWithApi(api, execution, options);
    expect(api.reopenedNumbers).toEqual([1]);

    const changedClose = new FakeApi();
    changedClose.open = [pull({ changed_files: 0 })];
    changedClose.refs.set("heads/main", "base");
    changedClose.refs.set(`heads/${branch}`, "moved");
    changedClose.details.set(1, [
      pull({ changed_files: 0 }),
      pull({ changed_files: 0 }),
      pull({ changed_files: 0 }),
      closed({ changed_files: 0 }),
      closed({ changed_files: 0 }),
      closed({ changed_files: 0, closed_at: "later", updated_at: "later" }),
    ]);
    await cleanupWithApi(changedClose, execution, options);
    expect(changedClose.reopenedNumbers).toEqual([]);
  });

  it("requires complete file count and identical tree identities for obsolete pulls", async () => {
    const api = new FakeApi();
    api.open = [pull()];
    api.refs.set("heads/main", "base");
    api.comparisons = [{ filename: "a" }];
    api.trees.set("head", new Map([["a", "100644\0blob\0same"]]));
    api.trees.set("base", new Map([["a", "100644\0blob\0different"]]));
    api.details.set(1, [pull(), pull()]);
    const result = await cleanupWithApi(api, execution, {
      ...defaults,
      closeObsoletePullRequests: true,
      closeStalePullRequests: false,
    });
    expect(result.closedPullRequests).toEqual([]);
  });

  it.each([
    ["changed-file count", [{ filename: "a" }], 2],
    ["empty comparison", [], 1],
  ])(
    "preserves when %s evidence is incomplete",
    async (_name, files, count) => {
      const api = new FakeApi();
      api.open = [pull({ changed_files: count })];
      api.refs.set("heads/main", "base");
      api.comparisons = files;
      api.details.set(1, [pull({ changed_files: count })]);
      const result = await cleanupWithApi(api, execution, {
        ...defaults,
        closeObsoletePullRequests: true,
      });
      expect(result.closedPullRequests).toEqual([]);
    },
  );

  it("includes both sides of a rename when comparing tree identities", async () => {
    const api = new FakeApi();
    api.open = [pull()];
    api.refs.set("heads/main", "base");
    api.refs.set(`heads/${branch}`, "head");
    api.comparisons = [{ filename: "new", previous_filename: "old" }];
    const identities = new Map([
      ["new", "100644\0blob\0new-id"],
      ["old", "100644\0blob\0old-id"],
    ]);
    api.trees.set("head", identities);
    api.trees.set("base", identities);
    api.details.set(1, [pull(), pull(), pull(), closed(), closed()]);
    const result = await cleanupWithApi(api, execution, {
      ...defaults,
      closeObsoletePullRequests: true,
    });
    expect(result.closedPullRequests).toEqual([1]);
  });

  it.each([
    ["truncated head tree", undefined, new Map([["a", "same"]])],
    ["truncated base tree", new Map([["a", "same"]]), undefined],
  ])("preserves on %s", async (_name, headTree, baseTree) => {
    const api = new FakeApi();
    api.open = [pull()];
    api.refs.set("heads/main", "base");
    api.comparisons = [{ filename: "a" }];
    api.trees.set("head", headTree);
    api.trees.set("base", baseTree);
    api.details.set(1, [pull()]);
    const result = await cleanupWithApi(api, execution, {
      ...defaults,
      closeObsoletePullRequests: true,
    });
    expect(result.closedPullRequests).toEqual([]);
  });

  it.each([
    [
      "head movement",
      pull({
        head: { ref: branch, sha: "new", repo: { full_name: repository } },
      }),
    ],
    ["base movement", pull()],
  ])(
    "preserves obsolete pull on %s during comparison",
    async (kind, refreshed) => {
      const api = new FakeApi();
      api.open = [pull()];
      api.refValues.set(
        "heads/main",
        kind === "base movement" ? ["base", "new-base"] : ["base", "base"],
      );
      api.comparisons = [{ filename: "a" }];
      const tree = new Map([["a", "same"]]);
      api.trees.set("head", tree);
      api.trees.set("base", tree);
      api.details.set(1, [pull(), refreshed]);
      const result = await cleanupWithApi(api, execution, {
        ...defaults,
        closeObsoletePullRequests: true,
        closeStalePullRequests: false,
      });
      expect(result.closedPullRequests).toEqual([]);
      expect(api.closedNumbers).toEqual([]);
    },
  );

  it("reopens an exact close after the base moves post-close", async () => {
    const api = new FakeApi();
    api.open = [pull({ changed_files: 0 })];
    api.refValues.set("heads/main", ["base", "base", "moved"]);
    api.refs.set(`heads/${branch}`, "head");
    api.details.set(1, [
      pull({ changed_files: 0 }),
      pull({ changed_files: 0 }),
      pull({ changed_files: 0 }),
      closed({ changed_files: 0 }),
      closed({ changed_files: 0 }),
      closed({ changed_files: 0 }),
    ]);
    await cleanupWithApi(api, execution, {
      ...defaults,
      closeObsoletePullRequests: true,
    });
    expect(api.reopenedNumbers).toEqual([1]);
  });

  it("allows compensation after a new head revision with the same close event", async () => {
    const api = new FakeApi();
    api.open = [pull({ changed_files: 0 })];
    api.refs.set("heads/main", "base");
    api.refs.set(`heads/${branch}`, "moved");
    api.details.set(1, [
      pull({ changed_files: 0 }),
      pull({ changed_files: 0 }),
      pull({ changed_files: 0 }),
      closed({ changed_files: 0 }),
      closed({ changed_files: 0 }),
      closed({
        changed_files: 0,
        head: { ref: branch, sha: "new", repo: { full_name: repository } },
      }),
    ]);
    await cleanupWithApi(api, execution, {
      ...defaults,
      closeObsoletePullRequests: true,
    });
    expect(api.reopenedNumbers).toEqual([1]);
  });

  it.each([
    ["independent reclose", { updated_at: "later", closed_at: "later" }],
    ["moved base", { base: { ref: "release" } }],
    ["lost ownership", { labels: [] }],
  ])("does not compensate after %s", async (_name, override) => {
    const api = new FakeApi();
    api.open = [pull({ changed_files: 0 })];
    api.refs.set("heads/main", "base");
    api.refs.set(`heads/${branch}`, "moved");
    api.details.set(1, [
      pull({ changed_files: 0 }),
      pull({ changed_files: 0 }),
      pull({ changed_files: 0 }),
      closed({ changed_files: 0 }),
      closed({ changed_files: 0 }),
      closed({ changed_files: 0, ...override }),
    ]);
    await cleanupWithApi(api, execution, {
      ...defaults,
      closeObsoletePullRequests: true,
    });
    expect(api.reopenedNumbers).toEqual([]);
  });

  it("propagates validation errors after compensating an exact close", async () => {
    const api = new FakeApi();
    api.open = [pull({ changed_files: 0 })];
    api.refs.set("heads/main", "base");
    api.details.set(1, [
      pull({ changed_files: 0 }),
      pull({ changed_files: 0 }),
      pull({ changed_files: 0 }),
      closed({ changed_files: 0 }),
      pull({ state: "closed", changed_files: -1 }),
      closed({ changed_files: 0 }),
    ]);
    await expect(
      cleanupWithApi(api, execution, {
        ...defaults,
        closeObsoletePullRequests: true,
      }),
    ).rejects.toThrow("valid changed file count");
    expect(api.reopenedNumbers).toEqual([1]);
  });

  it("retains snapshot and compensation errors when reopening fails", async () => {
    const api = new FakeApi();
    const compensation = new Error("reopen failed");
    api.reopenError = compensation;
    api.open = [pull({ changed_files: 0 })];
    api.refs.set("heads/main", "base");
    api.details.set(1, [
      pull({ changed_files: 0 }),
      pull({ changed_files: 0 }),
      pull({ changed_files: 0 }),
      closed({ changed_files: 0 }),
      pull({ state: "closed", changed_files: -1 }),
      closed({ changed_files: 0 }),
    ]);
    const failure = await cleanupWithApi(api, execution, {
      ...defaults,
      closeObsoletePullRequests: true,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(2);
    expect((failure as AggregateError).errors[0]).toMatchObject({
      message: expect.stringContaining("valid changed file count"),
    });
    expect((failure as AggregateError).errors[1]).toBe(compensation);
  });

  it.each<DeleteRefOutcome>(["already-absent", "lease-rejected"])(
    "does not claim a %s deletion outcome",
    async (outcome) => {
      const api = new FakeApi();
      const candidate = closed();
      api.closed = [candidate];
      api.refs.set(`heads/${branch}`, "head");
      api.details.set(1, [candidate]);
      api.deleteOutcome = outcome;
      const result = await cleanupWithApi(api, execution, defaults);
      expect(result.deletedBranches).toEqual([]);
    },
  );

  it("blocks deletion when an open pull appears during the final race check", async () => {
    const api = new FakeApi();
    const candidate = closed();
    api.closed = [candidate];
    api.refs.set(`heads/${branch}`, "head");
    api.details.set(1, [candidate]);
    api.listOpenValues = [[], [pull({ number: 9 })]];
    const result = await cleanupWithApi(api, execution, defaults);
    expect(result.deletedBranches).toEqual([]);
    expect(api.deleted).toEqual([]);
  });

  it("restores the leased branch when an open pull appears after deletion", async () => {
    const api = new FakeApi();
    const candidate = closed();
    api.closed = [candidate];
    api.refs.set(`heads/${branch}`, "head");
    api.details.set(1, [candidate]);
    api.listOpenValues = [[], [], [pull({ number: 9 })]];
    const result = await cleanupWithApi(api, execution, defaults);
    expect(result.deletedBranches).toEqual([]);
    expect(api.deleted).toEqual([[`heads/${branch}`, "head"]]);
    expect(api.refs.get(`heads/${branch}`)).toBe("head");
  });

  it.each([
    ["updated timestamp", { updated_at: "later" }],
    ["merge classification", { merged_at: "2026-01-01T00:02:00Z" }],
    ["ownership", { body: "unowned" }],
  ])("blocks closed deletion after changed %s", async (_name, override) => {
    const api = new FakeApi();
    api.closed = [closed()];
    api.refs.set(`heads/${branch}`, "head");
    api.details.set(1, [closed(override)]);
    const result = await cleanupWithApi(api, execution, defaults);
    expect(result.deletedBranches).toEqual([]);
  });

  it("deletes both merged and stale owned branches when enabled", async () => {
    const api = new FakeApi();
    const stale = closed();
    const merged = closed({
      number: 2,
      merged_at: "2026-01-01T00:01:00Z",
      head: {
        ref: "prek-autoupdate-2",
        sha: "head2",
        repo: { full_name: repository },
      },
    });
    api.closed = [stale, merged];
    api.refs.set(`heads/${branch}`, "head");
    api.refs.set("heads/prek-autoupdate-2", "head2");
    api.details.set(1, [stale]);
    api.details.set(2, [merged]);
    const result = await cleanupWithApi(api, execution, defaults);
    expect(result.deletedBranches).toEqual([branch, "prek-autoupdate-2"]);
  });
});

import { describe, expect, it, vi } from "vitest";

import type { GitHubClient } from "../../src/contracts.js";
import { OctokitCleanupApi } from "../../src/cleanup/github.js";

function client(overrides: Record<string, unknown> = {}): GitHubClient {
  const rest = {
    pulls: {
      list: vi.fn(),
      get: vi.fn(),
      update: vi.fn(),
    },
    repos: { compareCommitsWithBasehead: vi.fn() },
    git: { getTree: vi.fn(), getRef: vi.fn(), createRef: vi.fn() },
  };
  return {
    rest,
    paginate: {
      iterator: vi.fn(),
    },
    ...overrides,
  } as unknown as GitHubClient;
}

describe("OctokitCleanupApi evidence adapters", () => {
  it("collects every pagination page", async () => {
    const github = client();
    vi.mocked(github.paginate.iterator).mockReturnValue(
      (async function* () {
        yield { data: [{ number: 1 }] } as never;
        yield { data: [{ number: 2 }] } as never;
      })() as never,
    );
    const api = new OctokitCleanupApi(github, "owner", "repo", "token");
    await expect(api.listPulls("closed")).resolves.toEqual([
      { number: 1 },
      { number: 2 },
    ]);
    expect(github.paginate.iterator).toHaveBeenCalledWith(
      github.rest.pulls.list,
      expect.objectContaining({ state: "closed", per_page: 100 }),
    );
  });

  it("rejects malformed objects from pagination", async () => {
    const github = client();
    vi.mocked(github.paginate.iterator).mockReturnValue(
      (async function* () {
        yield { data: [null] } as never;
      })() as never,
    );
    const api = new OctokitCleanupApi(github, "owner", "repo", "token");
    await expect(api.listPulls("open")).rejects.toThrow(
      "Expected pull request object",
    );
  });

  it("requires immutable comparison endpoints and a file list", async () => {
    const github = client();
    vi.mocked(github.paginate.iterator).mockReturnValue(
      (async function* () {
        yield {
          data: {
            base_commit: { sha: "base" },
            commits: [{ sha: "wrong" }],
            files: [],
          },
        } as never;
      })() as never,
    );
    const api = new OctokitCleanupApi(github, "owner", "repo", "token");
    await expect(api.compareFiles("base", "head")).rejects.toThrow(
      "immutable revisions",
    );
  });

  it("validates the final commit page while retaining only first-page files", async () => {
    const github = client();
    vi.mocked(github.paginate.iterator).mockReturnValue(
      (async function* () {
        yield {
          data: {
            base_commit: { sha: "base" },
            commits: [{ sha: "middle" }],
            files: [{ filename: "first" }],
            changed_files: 1,
            total_commits: 2,
          },
        } as never;
        yield {
          data: {
            commits: [{ sha: "head" }],
            files: [{ filename: "must-not-be-flattened" }],
          },
        } as never;
      })() as never,
    );
    const api = new OctokitCleanupApi(github, "owner", "repo", "token");
    await expect(api.compareFiles("base", "head")).resolves.toEqual([
      { filename: "first" },
    ]);
    expect(github.paginate.iterator).toHaveBeenCalledWith(
      github.rest.repos.compareCommitsWithBasehead,
      expect.objectContaining({ basehead: "base...head", per_page: 100 }),
    );
  });

  it("fails closed when GitHub caps a comparison below changed_files", async () => {
    const github = client();
    vi.mocked(github.paginate.iterator).mockReturnValue(
      (async function* () {
        yield {
          data: {
            base_commit: { sha: "base" },
            commits: [{ sha: "head" }],
            files: Array.from({ length: 300 }, (_, index) => ({
              filename: `${index}`,
            })),
            changed_files: 301,
            total_commits: 1,
          },
        } as never;
      })() as never,
    );
    const api = new OctokitCleanupApi(github, "owner", "repo", "token");
    await expect(api.compareFiles("base", "head")).rejects.toThrow(
      "300-file limit",
    );
  });

  it("uses the checked pull ETag as the reopen precondition", async () => {
    const github = client();
    vi.mocked(github.rest.pulls.get).mockResolvedValue({
      data: { number: 7, state: "closed" },
      headers: { etag: '"revision"' },
    } as never);
    vi.mocked(github.rest.pulls.update).mockResolvedValue({
      data: { number: 7, state: "open" },
    } as never);
    const api = new OctokitCleanupApi(github, "owner", "repo", "token");
    await expect(api.getVersionedPull(7)).resolves.toEqual({
      pull: { number: 7, state: "closed" },
      etag: '"revision"',
    });
    await expect(api.reopenPull(7, '"revision"')).resolves.toEqual({
      number: 7,
      state: "open",
    });
    expect(github.rest.pulls.update).toHaveBeenCalledWith(
      expect.objectContaining({
        pull_number: 7,
        state: "open",
        headers: { "if-match": '"revision"' },
      }),
    );
  });

  it("returns undefined for a truncated tree", async () => {
    const github = client();
    vi.mocked(github.rest.git.getTree).mockResolvedValue({
      data: { truncated: true, tree: [] },
    } as never);
    const api = new OctokitCleanupApi(github, "owner", "repo", "token");
    await expect(
      api.getTreeEntries(new Set(["a"]), "head"),
    ).resolves.toBeUndefined();
  });

  it("preserves explicit missing paths and records complete tree identities", async () => {
    const github = client();
    vi.mocked(github.rest.git.getTree).mockResolvedValue({
      data: {
        truncated: false,
        tree: [{ path: "a", mode: "100644", type: "blob", sha: "id" }],
      },
    } as never);
    const api = new OctokitCleanupApi(github, "owner", "repo", "token");
    await expect(
      api.getTreeEntries(new Set(["a", "missing"]), "head"),
    ).resolves.toEqual(
      new Map([
        ["a", "100644\0blob\0id"],
        ["missing", undefined],
      ]),
    );
  });

  it("maps a missing ref to undefined but propagates other errors", async () => {
    const github = client();
    vi.mocked(github.rest.git.getRef)
      .mockRejectedValueOnce({ status: 404 })
      .mockRejectedValueOnce(new Error("timeout"));
    const api = new OctokitCleanupApi(github, "owner", "repo", "token");
    await expect(api.getRefSha("heads/missing")).resolves.toBeUndefined();
    await expect(api.getRefSha("heads/branch")).rejects.toThrow("timeout");
  });
});

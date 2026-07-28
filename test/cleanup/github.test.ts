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
    git: { getTree: vi.fn(), getRef: vi.fn() },
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
    vi.mocked(github.rest.repos.compareCommitsWithBasehead).mockResolvedValue({
      data: {
        base_commit: { sha: "base" },
        commits: [{ sha: "wrong" }],
        files: [],
      },
    } as never);
    const api = new OctokitCleanupApi(github, "owner", "repo", "token");
    await expect(api.compareFiles("base", "head")).rejects.toThrow(
      "immutable revisions",
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

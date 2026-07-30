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
    const api = new OctokitCleanupApi(
      github,
      "owner",
      "repo",
      "token",
      "https://github.com",
    );
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
    const api = new OctokitCleanupApi(
      github,
      "owner",
      "repo",
      "token",
      "https://github.com",
    );
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
    const api = new OctokitCleanupApi(
      github,
      "owner",
      "repo",
      "token",
      "https://github.com",
    );
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
    const api = new OctokitCleanupApi(
      github,
      "owner",
      "repo",
      "token",
      "https://github.com",
    );
    await expect(api.compareFiles("base", "head")).resolves.toEqual([
      { filename: "first" },
    ]);
    expect(github.paginate.iterator).toHaveBeenCalledWith(
      github.rest.repos.compareCommitsWithBasehead,
      expect.objectContaining({ basehead: "base...head", per_page: 100 }),
    );
  });

  it.each([
    ["missing", undefined],
    ["non-numeric", "301"],
    ["larger than returned files", 301],
  ])(
    "fails closed when a capped comparison has %s changed_files",
    async (_name, changedFiles) => {
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
              ...(changedFiles === undefined
                ? {}
                : { changed_files: changedFiles }),
            },
          } as never;
        })() as never,
      );
      const api = new OctokitCleanupApi(
        github,
        "owner",
        "repo",
        "token",
        "https://github.com",
      );
      await expect(api.compareFiles("base", "head")).rejects.toThrow(
        "300-file limit",
      );
    },
  );

  it("reopens a pull and returns an authoritative refreshed payload", async () => {
    const github = client();
    vi.mocked(github.rest.pulls.update).mockResolvedValue({
      data: { number: 7, state: "closed" },
    } as never);
    vi.mocked(github.rest.pulls.get).mockResolvedValue({
      data: { number: 7, state: "open" },
    } as never);
    const api = new OctokitCleanupApi(
      github,
      "owner",
      "repo",
      "token",
      "https://github.com",
    );
    await expect(api.reopenPull(7)).resolves.toEqual({
      number: 7,
      state: "open",
    });
    expect(github.rest.pulls.update).toHaveBeenCalledWith(
      expect.objectContaining({
        pull_number: 7,
        state: "open",
      }),
    );
  });

  it("returns undefined for a truncated tree", async () => {
    const github = client();
    vi.mocked(github.rest.git.getTree).mockResolvedValue({
      data: { truncated: true, tree: [] },
    } as never);
    const api = new OctokitCleanupApi(
      github,
      "owner",
      "repo",
      "token",
      "https://github.com",
    );
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
    const api = new OctokitCleanupApi(
      github,
      "owner",
      "repo",
      "token",
      "https://github.com",
    );
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
    const api = new OctokitCleanupApi(
      github,
      "owner",
      "repo",
      "token",
      "https://github.com",
    );
    await expect(api.getRefSha("heads/missing")).resolves.toBeUndefined();
    await expect(api.getRefSha("heads/branch")).rejects.toThrow("timeout");
  });

  it("restores a ref with the requested full ref and revision", async () => {
    const github = client();
    vi.mocked(github.rest.git.createRef).mockResolvedValue({
      data: { ref: "refs/heads/branch", object: { sha: "head" } },
    } as never);
    const api = new OctokitCleanupApi(
      github,
      "owner",
      "repo",
      "token",
      "https://github.com",
    );

    await expect(
      api.restoreRef("heads/branch", "head"),
    ).resolves.toBeUndefined();
    expect(github.rest.git.createRef).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      ref: "refs/heads/branch",
      sha: "head",
    });
  });

  it("accepts a create conflict only when a fresh read finds the ref", async () => {
    const github = client();
    vi.mocked(github.rest.git.createRef).mockRejectedValue({ status: 422 });
    vi.mocked(github.rest.git.getRef).mockResolvedValue({
      data: { object: { sha: "concurrent" } },
    } as never);
    const api = new OctokitCleanupApi(
      github,
      "owner",
      "repo",
      "token",
      "https://github.com",
    );

    await expect(
      api.restoreRef("heads/branch", "head"),
    ).resolves.toBeUndefined();
    expect(github.rest.git.getRef).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      ref: "heads/branch",
    });
  });

  it("propagates create conflicts when the ref is still absent", async () => {
    const github = client();
    const conflict = { status: 422 };
    vi.mocked(github.rest.git.createRef).mockRejectedValue(conflict);
    vi.mocked(github.rest.git.getRef).mockRejectedValue({ status: 404 });
    const api = new OctokitCleanupApi(
      github,
      "owner",
      "repo",
      "token",
      "https://github.com",
    );

    await expect(api.restoreRef("heads/branch", "head")).rejects.toBe(conflict);
  });
});

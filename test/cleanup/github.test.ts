import { getOctokit } from "@actions/github";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import type { GitHubClient } from "../../src/contracts.js";
import { OctokitGitHubApi } from "../../src/github.js";

const apiUrl = "https://api.example.test";
const repositoryPath = "/repos/owner/repo";

function client(
  respond: (url: URL, request: RequestInit | undefined) => Response,
): GitHubClient {
  return getOctokit("test-token", {
    baseUrl: apiUrl,
    request: {
      fetch: async (url: string, request?: RequestInit) =>
        respond(new URL(url), request),
    },
  });
}

function adapter(
  respond: Parameters<typeof client>[0],
  serverUrl = "https://github.com",
): OctokitGitHubApi {
  return new OctokitGitHubApi(
    client(respond),
    "owner",
    "repo",
    "test-token",
    serverUrl,
  );
}

function jsonPage(data: unknown, next?: string): Response {
  return Response.json(
    data,
    next === undefined
      ? {}
      : {
          headers: { link: `<${apiUrl}${next}>; rel="next"` },
        },
  );
}

function failed(status: number): Response {
  return Response.json({ message: `HTTP ${status}` }, { status });
}

describe("Octokit GitHub adapter", () => {
  it("returns closed pulls from every linked page, even if a page is short", async () => {
    const path = `${repositoryPath}/pulls`;
    const api = adapter((url) => {
      if (url.pathname !== path || url.searchParams.get("state") !== "closed")
        return failed(404);
      switch (url.searchParams.get("page")) {
        case "2":
          return jsonPage([], `${path}?state=closed&page=3`);
        case "3":
          return jsonPage([{ number: 3 }]);
        default:
          return jsonPage([{ number: 1 }], `${path}?state=closed&page=2`);
      }
    });

    await expect(api.listPulls("closed")).resolves.toEqual([
      { number: 1 },
      { number: 3 },
    ]);
  });

  it("rejects malformed pull objects on a later page", async () => {
    const path = `${repositoryPath}/pulls`;
    const api = adapter((url) =>
      url.searchParams.has("page")
        ? jsonPage([null])
        : jsonPage([{ number: 1 }], `${path}?page=2`),
    );

    await expect(api.listPulls("open")).rejects.toThrow(
      "Expected pull request object",
    );
  });

  it.each([
    ["a different head", "base", "wrong", []],
    ["a different base", "wrong", "head", []],
    ["no file list", "base", "head", undefined],
  ])(
    "rejects comparison evidence with %s",
    async (_name, base, head, files) => {
      const api = adapter(() =>
        jsonPage({
          url: `${apiUrl}${repositoryPath}/compare/base...head`,
          base_commit: { sha: base },
          commits: [{ sha: head }],
          files,
        }),
      );

      await expect(api.compareFiles("base", "head")).rejects.toThrow(
        files === undefined
          ? "Expected comparison file list"
          : "immutable revisions",
      );
    },
  );

  it("validates the final linked comparison page and uses first-page files", async () => {
    const path = `${repositoryPath}/compare/base...head`;
    const api = adapter((url) => {
      if (decodeURIComponent(url.pathname) !== path) return failed(404);
      if (url.searchParams.get("page") === "2") {
        return jsonPage({
          url: `${apiUrl}${path}`,
          commits: [{ sha: "head" }],
          files: [{ filename: "must-not-be-flattened" }],
        });
      }
      return jsonPage(
        {
          url: `${apiUrl}${path}`,
          base_commit: { sha: "base" },
          commits: [{ sha: "middle" }],
          files: [{ filename: "first" }],
          total_commits: 2,
        },
        `${path}?page=2`,
      );
    });

    await expect(api.compareFiles("base", "head")).resolves.toEqual([
      { filename: "first" },
    ]);
  });

  it.each([
    ["missing", undefined],
    ["non-numeric", "301"],
    ["larger than returned files", 301],
  ])(
    "rejects a capped comparison with %s changed_files",
    async (_name, changedFiles) => {
      const api = adapter(() =>
        jsonPage({
          url: `${apiUrl}${repositoryPath}/compare/base...head`,
          base_commit: { sha: "base" },
          commits: [{ sha: "head" }],
          files: Array.from({ length: 300 }, (_, index) => ({
            filename: `${index}`,
          })),
          changed_files: changedFiles,
        }),
      );

      await expect(api.compareFiles("base", "head")).rejects.toThrow(
        "300-file limit",
      );
    },
  );

  it("reopens the selected pull and returns its authoritative refreshed payload", async () => {
    const pulls = new Map([
      [7, "closed"],
      [8, "closed"],
    ]);
    const api = adapter((url, request) => {
      const number = Number(url.pathname.split("/").at(-1));
      if (!pulls.has(number)) return failed(404);
      if (request?.method === "PATCH") {
        const body = JSON.parse(String(request.body)) as Record<
          string,
          unknown
        >;
        if (body.state !== "open") return failed(422);
        pulls.set(number, "open");
        return jsonPage({ number, state: "closed" });
      }
      return jsonPage({ number, state: pulls.get(number) });
    });

    await expect(api.reopenPull(7)).resolves.toEqual({
      number: 7,
      state: "open",
    });
    expect(pulls.get(7)).toBe("open");
    expect(pulls.get(8)).toBe("closed");
  });

  it("sends the close event ETag when conditionally reopening a pull", async () => {
    const path = `${repositoryPath}/pulls/7`;
    let state = "closed";
    const api = adapter((url, request) => {
      if (url.pathname !== path || request?.method !== "PATCH")
        return failed(404);
      const { state: requestedState } = JSON.parse(String(request.body)) as {
        state?: string;
      };
      if (requestedState !== "open") return failed(422);
      if (new Headers(request.headers).get("if-match") !== '"current-close"')
        return failed(412);
      state = requestedState;
      return jsonPage({ number: 7, state });
    });

    await expect(
      api.updatePull(7, { state: "open" }, '"stale-close"'),
    ).rejects.toMatchObject({ status: 412 });
    expect(state).toBe("closed");

    await expect(
      api.updatePull(7, { state: "open" }, '"current-close"'),
    ).resolves.toMatchObject({ data: { number: 7, state: "open" } });
    expect(state).toBe("open");
  });

  it.each([
    { number: 7, state: "closed" },
    { number: 8, state: "open" },
  ])("rejects a reopened pull that refreshes as %j", async (refreshed) => {
    const api = adapter(() => jsonPage(refreshed));

    await expect(api.reopenPull(7)).rejects.toThrow(
      "Reopen response did not match requested pull",
    );
  });

  it("returns undefined for a truncated tree", async () => {
    const api = adapter(() => jsonPage({ truncated: true, tree: [] }));

    await expect(
      api.getTreeEntries(new Set(["a"]), "head"),
    ).resolves.toBeUndefined();
  });

  it("preserves explicit missing paths and complete tree identities", async () => {
    const api = adapter(() =>
      jsonPage({
        truncated: false,
        tree: [{ path: "a", mode: "100644", type: "blob", sha: "id" }],
      }),
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

  it("rejects a relevant tree entry without a complete identity", async () => {
    const api = adapter(() =>
      jsonPage({
        truncated: false,
        tree: [{ path: "a", mode: "100644", type: "blob" }],
      }),
    );

    await expect(api.getTreeEntries(new Set(["a"]), "head")).rejects.toThrow(
      "Expected a complete Git tree entry",
    );
  });

  it("maps a missing ref to undefined and propagates other API errors", async () => {
    const api = adapter((url) =>
      failed(decodeURIComponent(url.pathname).endsWith("/missing") ? 404 : 503),
    );

    await expect(api.getRefSha("heads/missing")).resolves.toBeUndefined();
    await expect(api.getRefSha("heads/branch")).rejects.toMatchObject({
      status: 503,
    });
  });

  it.each([404, 410])(
    "distinguishes a vanished pull (%i) from a required lookup",
    async (status) => {
      const api = adapter(() => failed(status));

      await expect(api.findPull(7)).resolves.toBeUndefined();
      await expect(api.getPull(7)).rejects.toMatchObject({ status });
    },
  );

  it("propagates transient errors from optional pull lookups", async () => {
    const api = adapter(() => failed(503));

    await expect(api.findPull(7)).rejects.toMatchObject({ status: 503 });
  });

  it("restores a ref at the requested revision without overwriting existing refs", async () => {
    const refs = new Map([["refs/heads/concurrent", "new"]]);
    const api = adapter((url, request) => {
      if (
        url.pathname === `${repositoryPath}/git/refs` &&
        request?.method === "POST"
      ) {
        const body = JSON.parse(String(request.body)) as {
          ref: string;
          sha: string;
        };
        if (!body.ref.startsWith("refs/heads/") || refs.has(body.ref))
          return failed(422);
        refs.set(body.ref, body.sha);
        return jsonPage({ ref: body.ref, object: { sha: body.sha } });
      }
      const ref = decodeURIComponent(
        url.pathname.slice(`${repositoryPath}/git/ref/`.length),
      );
      const sha = refs.get(`refs/${ref}`);
      return sha === undefined ? failed(404) : jsonPage({ object: { sha } });
    });

    await api.restoreRef("heads/missing", "head");
    await api.restoreRef("heads/concurrent", "head");

    expect(refs.get("refs/heads/missing")).toBe("head");
    expect(refs.get("refs/heads/concurrent")).toBe("new");
  });

  it("propagates a restore validation error when the ref is still absent", async () => {
    const api = adapter((_url, request) =>
      failed(request?.method === "POST" ? 422 : 404),
    );

    await expect(api.restoreRef("heads/branch", "head")).rejects.toMatchObject({
      status: 422,
    });
  });

  it("lease-deletes only the expected revision in a real remote repository", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prek-github-adapter-"));
    const remote = join(directory, "owner", "repo.git");
    const workspace = join(directory, "work");
    const ref = "refs/heads/update";
    const run = (...args: string[]): string =>
      execFileSync("git", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();

    try {
      await mkdir(join(directory, "owner"));
      run("init", "--bare", remote);
      run("init", workspace);
      const commit = (): string => {
        run(
          "-C",
          workspace,
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "core.hooksPath=/dev/null",
          "commit",
          "--allow-empty",
          "-m",
          "Update",
        );
        return run("-C", workspace, "rev-parse", "HEAD");
      };
      const older = commit();
      const newer = commit();
      run("-C", workspace, "push", remote, `HEAD:${ref}`);

      const readRemote = (): string | undefined => {
        const listing = run("ls-remote", remote, ref);
        return listing === "" ? undefined : listing.split("\t")[0];
      };
      const api = adapter(() => {
        const sha = readRemote();
        return sha === undefined ? failed(404) : jsonPage({ object: { sha } });
      }, pathToFileURL(directory).href);

      await expect(api.deleteRef("heads/update", older)).resolves.toBe(
        "lease-rejected",
      );
      expect(readRemote()).toBe(newer);

      await expect(api.deleteRef("heads/update", newer)).resolves.toBe(
        "deleted",
      );
      expect(readRemote()).toBeUndefined();

      await expect(api.deleteRef("heads/update", newer)).resolves.toBe(
        "already-absent",
      );
      expect(readRemote()).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

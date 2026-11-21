import * as core from "@actions/core";
import { getOctokit } from "@actions/github";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspect, promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import type * as EnvironmentModule from "../../src/environment.js";

vi.mock("@actions/core", async (importOriginal) => {
  const actual = await importOriginal<typeof core>();
  return { ...actual, warning: vi.fn() };
});
const installPrek = vi.hoisted(() =>
  vi.fn<() => Promise<{ binary: string; cleanup: () => Promise<void> }>>(),
);
vi.mock("../../src/prek/index.js", () => ({ installPrek }));
vi.mock("../../src/environment.js", async (importOriginal) => {
  const actual = await importOriginal<typeof EnvironmentModule>();
  return {
    ...actual,
    sanitizedChildEnvironment: (
      additions: NodeJS.ProcessEnv = {},
    ): NodeJS.ProcessEnv => ({
      ...actual.sanitizedChildEnvironment(additions),
      PATH: process.env.PATH,
    }),
  };
});

import { cleanupWithApi } from "../../src/cleanup/index.js";
import {
  PublishedPullRequestError,
  type ActionExecution,
  type GitHubClient,
} from "../../src/contracts.js";
import { deleteBranch } from "../../src/git.js";
import { OctokitGitHubApi, type NewPull } from "../../src/github.js";
import { InMemoryGitHub } from "../support/in-memory-github.js";
import { BODY_MARKER } from "../../src/ownership.js";
import { runUpdate } from "../../src/update/index.js";

const exec = promisify(execFile);
const updateBranch = "chore/prek-updates";
const updateRef = `heads/${updateBranch}`;
const cleanups: string[] = [];
const originalPath = process.env.PATH;

afterEach(async () => {
  process.env.PATH = originalPath;
  delete process.env.TEST_GIT_LOG;
  delete process.env.TEST_GIT_REMOTE;
  delete process.env.TEST_GIT_URL;
  delete process.env.TEST_GIT_FAIL_PUSH;
  delete process.env.TEST_GIT_FAILURE_OUTPUT;
  delete process.env.TEST_GIT_FAIL_DIFF;
  delete process.env.TEST_GIT_FAIL_WORKTREE_REMOVE;
  delete process.env.TEST_GIT_FAIL_WORKTREE_LIST;
  delete process.env.TEST_GIT_LEGACY_WORKTREE_LIST;
  delete process.env.TEST_GIT_LOCK_WORKTREE_ON_REMOVE;
  delete process.env.TEST_GIT_UNREGISTER_WORKTREE_ON_REMOVE;
  delete process.env.TEST_GIT_FAIL_WORKTREE_ADD_AFTER;
  delete process.env.TEST_GIT_FAIL_WORKTREE_ADD_BEFORE;
  delete process.env.TEST_GIT_WORKTREE_REMOVE_SENTINEL;
  vi.unstubAllEnvs();
  installPrek.mockReset();
  vi.mocked(core.warning).mockReset();
  await Promise.all(
    cleanups
      .splice(0)
      .map((entry) => rm(entry, { recursive: true, force: true })),
  );
});

describe("update publication races", () => {
  it.each(["modern", "legacy"])(
    "cleans a pre-registration worktree add failure with %s Git",
    async (gitVersion) => {
      const { execution, initial, scratch, workspace } =
        await makeWorktreeHarness();
      process.env.TEST_GIT_FAIL_WORKTREE_ADD_BEFORE = "1";
      if (gitVersion === "legacy") {
        process.env.TEST_GIT_LEGACY_WORKTREE_LIST = "1";
      }

      const error = await runUpdate(execution, execution.api).catch(
        (caught: unknown) => caught,
      );

      delete process.env.TEST_GIT_LEGACY_WORKTREE_LIST;
      expect(await worktrees(workspace)).toEqual(initial);
      expect(await readdir(scratch)).toEqual([]);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(AggregateError);
    },
  );

  it("cleans a partially successful worktree add", async () => {
    const { execution, initial, scratch, workspace } =
      await makeWorktreeHarness();
    process.env.TEST_GIT_FAIL_WORKTREE_ADD_AFTER = "1";

    await expect(runUpdate(execution, execution.api)).rejects.toThrow();

    expect(await worktrees(workspace)).toEqual(initial);
    expect(await readdir(scratch)).toEqual([]);
  });

  it("retries worktree removal after a transient failure", async () => {
    const { execution, initial, scratch, workspace } =
      await makeWorktreeHarness();
    process.env.TEST_GIT_FAIL_WORKTREE_REMOVE = "once";

    await expect(runUpdate(execution, execution.api)).resolves.toEqual({
      operation: "none",
    });

    expect(await worktrees(workspace)).toEqual(initial);
    expect(await readdir(scratch)).toEqual([]);
  });

  it.each([
    { scenario: "a path containing a newline", scratchName: "worktree\ntmp" },
    {
      scenario: "legacy Git",
      scratchName: "worktree tmp",
      legacyGit: true,
    },
    {
      scenario: "legacy Git and a path containing a newline",
      scratchName: "worktree\ntmp",
      legacyGit: true,
      ambiguousPath: true,
    },
    {
      scenario: "failed registration inspection",
      scratchName: "worktree-tmp",
      inspectionFails: true,
    },
  ])(
    "preserves a registered worktree after persistent removal failure with $scenario",
    async ({ scratchName, inspectionFails, legacyGit, ambiguousPath }) => {
      const { execution, initial, workspace } =
        await makeWorktreeHarness(scratchName);
      process.env.TEST_GIT_FAIL_WORKTREE_REMOVE = "always";
      if (inspectionFails) {
        process.env.TEST_GIT_FAIL_WORKTREE_LIST = "1";
      }
      if (legacyGit) {
        process.env.TEST_GIT_LEGACY_WORKTREE_LIST = "1";
      }

      await expect(runUpdate(execution, execution.api)).rejects.toMatchObject({
        message: "Update operation completed but cleanup failed",
        errors: [
          expect.objectContaining({
            message: expect.stringContaining(
              inspectionFails || ambiguousPath
                ? "Failed to reconcile action-owned worktree registration"
                : "Failed to remove action-owned worktree",
            ),
          }),
        ],
      });

      delete process.env.TEST_GIT_FAIL_WORKTREE_LIST;
      delete process.env.TEST_GIT_LEGACY_WORKTREE_LIST;
      const preserved = (await worktrees(workspace)).filter(
        (entry) => !initial.includes(entry),
      );
      expect(preserved).toHaveLength(1);
      await expect(access(preserved[0]!)).resolves.toBeUndefined();
    },
  );

  it("preserves a worktree locked before the removal retry", async () => {
    const { execution, initial, workspace } = await makeWorktreeHarness();
    process.env.TEST_GIT_FAIL_WORKTREE_REMOVE = "once";
    process.env.TEST_GIT_LOCK_WORKTREE_ON_REMOVE = "1";

    await expect(runUpdate(execution, execution.api)).rejects.toMatchObject({
      message: "Update operation completed but cleanup failed",
      errors: [
        expect.objectContaining({
          message: expect.stringContaining("preserved for inspection"),
        }),
      ],
    });

    const preserved = (await worktrees(workspace)).filter(
      (entry) => !initial.includes(entry),
    );
    expect(preserved).toHaveLength(1);
    await expect(access(preserved[0]!)).resolves.toBeUndefined();
  });

  it("warns when failed removals are reconciled by an absent registration", async () => {
    const { execution, initial, scratch, workspace } =
      await makeWorktreeHarness();
    process.env.TEST_GIT_FAIL_WORKTREE_REMOVE = "always";
    process.env.TEST_GIT_UNREGISTER_WORKTREE_ON_REMOVE = "1";

    await expect(runUpdate(execution, execution.api)).resolves.toEqual({
      operation: "none",
    });

    expect(await worktrees(workspace)).toEqual(initial);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        "registration was already absent; continuing cleanup",
      ),
    );
    expect(await readdir(scratch)).toEqual([]);
  });

  it("scopes authenticated pushes to the configured Actions server", async () => {
    const harness = await makeHarness({
      serverUrl: "https://github.example.com",
    });
    harness.api.transitions.beforeCreatePull = () => {
      throw restError("bad", 422);
    };

    await expect(runUpdate(harness.execution, harness.api)).rejects.toThrow(
      /lease-rolled back/u,
    );
    const observedPushes = await pushes(harness.log);
    expect(observedPushes).toHaveLength(2);
    for (const push of observedPushes) {
      expect(push).toContain(
        "http.https://github.example.com/.extraheader=AUTHORIZATION: basic",
      );
      expect(push).toContain("https://github.example.com/owner/repo.git");
      expect(push).not.toContain("https://github.com/owner/repo.git");
    }
  });

  it("lease-deletes the exact pushed SHA after a definite create failure", async () => {
    const harness = await makeHarness();
    harness.api.transitions.beforeCreatePull = () => {
      throw restError("bad", 422);
    };

    await expect(runUpdate(harness.execution, harness.api)).rejects.toThrow(
      /lease-rolled back/u,
    );
    expect(await pushes(harness.log)).toEqual([
      expect.stringContaining(
        "--force-with-lease=refs/heads/chore/prek-updates:",
      ),
      expect.stringMatching(
        /:refs\/heads\/chore\/prek-updates .*--force-with-lease=refs\/heads\/chore\/prek-updates:[0-9a-f]{40}/u,
      ),
    ]);
    expect([...harness.api.pulls.keys()]).toEqual([]);
  });

  it("reports a branch already absent after a definite create failure", async () => {
    const harness = await makeHarness();
    harness.api.transitions.beforeCreatePull = async () => {
      await exec("git", [
        "--git-dir",
        harness.remote,
        "update-ref",
        "-d",
        "refs/heads/chore/prek-updates",
        await remoteSha(harness.remote),
      ]);
      throw restError("bad", 422);
    };

    await expect(runUpdate(harness.execution, harness.api)).rejects.toThrow(
      /creation failed.*branch was already absent/u,
    );
    await expect(remoteSha(harness.remote)).rejects.toThrow();
  });

  it("preserves a moved ref when a definite create failure triggers rollback", async () => {
    const harness = await makeHarness();
    const movedSha = harness.execution.context.baseSha;
    harness.api.transitions.beforeCreatePull = async () => {
      await exec("git", [
        "--git-dir",
        harness.remote,
        "update-ref",
        "refs/heads/chore/prek-updates",
        movedSha,
        await remoteSha(harness.remote),
      ]);
      throw restError("bad", 422);
    };

    await expect(
      runUpdate(harness.execution, harness.api),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/rollback failed.*branch was preserved/u),
      cause: expect.objectContaining({
        errors: expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringMatching(/branch moved/u),
          }),
        ]),
      }),
    });
    expect(await remoteSha(harness.remote)).toBe(movedSha);
  });

  it("recovers an exact concurrent pull even when create reports 422", async () => {
    const harness = await makeHarness();
    harness.api.transitions.beforeCreatePull = async (request) => {
      await seedConcurrentPull(harness, request, 77);
      throw restError("already exists", 422);
    };

    await expect(runUpdate(harness.execution, harness.api)).resolves.toEqual({
      operation: "created",
      pullRequestNumber: 77,
    });
    expect(harness.api.pulls.get(77)).toMatchObject({
      state: "open",
      labels: [{ name: "dependencies" }],
      head: { sha: await remoteSha(harness.remote) },
    });
  });

  it("enables auto-merge after proving the exact created pull revision", async () => {
    const harness = await makeHarness();

    await expect(runWithAutoMerge(harness)).resolves.toEqual({
      operation: "created",
      pullRequestNumber: 42,
    });
    expect(harness.api.pulls.get(42)?.body).toContain(BODY_MARKER);
    expect(harness.api.autoMergeRequests.get(42)).toBe("SQUASH");
    await expectPublishedPull(harness);
  });

  it("preserves an existing squash auto-merge request", async () => {
    const harness = await makeHarness({ existing: true });
    harness.api.autoMergeRequests.set(42, "SQUASH");

    await expect(runWithAutoMerge(harness)).resolves.toEqual({
      operation: "updated",
      pullRequestNumber: 42,
    });
    expect(harness.api.autoMergeRequests.get(42)).toBe("SQUASH");
    await expectPublishedPull(harness);
  });

  it.each([
    {
      reason: "a prefix-only head branch",
      patch: { headRef: "chore/prek-old" },
    },
    { reason: "a closed pull request", patch: { state: "closed" } },
    { reason: "a different pull request number", patch: { number: 43 } },
    { reason: "a changed head revision", patch: { headSha: "other-revision" } },
    { reason: "an unowned pull request", patch: { user: { login: "other" } } },
  ])(
    "preserves the published update when it observes $reason",
    async ({ patch }) => {
      const harness = await makeHarness();
      let publishedSha: string | undefined;
      harness.api.transitions.beforeReadAutoMergePull = async (number) => {
        publishedSha = await remoteSha(harness.remote);
        const { headRef, headSha, ...metadata } = patch;
        const head = harness.api.pulls.get(number)?.head as ReturnType<
          typeof ownedPull
        >["head"];
        harness.api.patchPull(number, {
          ...metadata,
          head: { ...head, ref: headRef ?? head.ref, sha: headSha ?? head.sha },
        });
      };

      await expect(runWithAutoMerge(harness)).rejects.toMatchObject({
        publishedPullRequest: { operation: "created", pullRequestNumber: 42 },
        cause: expect.objectContaining({
          message:
            "Pull request changed before squash auto-merge could be enabled",
        }),
      });
      expect(harness.api.autoMergeRequests.get(42)).toBeUndefined();
      await expectPublishedPull(harness, patch.state ?? "open", publishedSha);
    },
  );

  it.each([
    { publication: "new", operation: "created" },
    { publication: "updated", operation: "updated" },
    { publication: "recovered metadata update", operation: "updated" },
  ] as const)(
    "keeps the $publication pull through cleanup after auto-merge fails",
    async ({ publication, operation }) => {
      const harness = await makeHarness({ existing: publication !== "new" });
      if (publication === "recovered metadata update") {
        harness.api.transitions.afterUpdatePull = () => {
          throw new Error("metadata response lost");
        };
      }
      harness.api.transitions.beforeEnableAutoMerge = () => {
        throw new Error("auto-merge rejected");
      };

      const error = await runWithAutoMerge(harness).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(PublishedPullRequestError);
      expect(error).toMatchObject({
        publishedPullRequest: { operation, pullRequestNumber: 42 },
        cause: expect.objectContaining({ message: "auto-merge rejected" }),
      });
      if (!(error instanceof PublishedPullRequestError)) throw error;

      const publishedSha = await remoteSha(harness.remote);
      const newerBranch = "chore/prek-newer";
      await exec("git", [
        "--git-dir",
        harness.remote,
        "update-ref",
        `refs/heads/${newerBranch}`,
        publishedSha,
      ]);
      const newer = ownedPull(publishedSha);
      harness.api.pulls.set(43, {
        ...newer,
        number: 43,
        changed_files: 1,
        head: { ...newer.head, ref: newerBranch },
      });
      await expect(
        cleanupWithApi(harness.api, harness.execution, {
          keepPullRequestNumber: error.publishedPullRequest.pullRequestNumber,
          keepLatestOpenPullRequest: false,
          closeStalePullRequests: true,
          closeObsoletePullRequests: false,
          deleteStaleBranches: true,
          deleteMergedBranches: true,
        }),
      ).resolves.toEqual({ closedPullRequests: [43], deletedBranches: [] });

      expect(harness.api.autoMergeRequests.get(42)).toBeUndefined();
      expect(harness.api.pulls.get(42)).toMatchObject({
        state: "open",
        head: { sha: publishedSha },
      });
      expect(await remoteSha(harness.remote)).toBe(publishedSha);
      expect(harness.api.pulls.get(43)?.state).toBe("closed");
    },
  );

  it("disables auto-merge when ownership changes after enabling it", async () => {
    const harness = await makeHarness();
    harness.api.transitions.afterEnableAutoMerge = (number) => {
      harness.api.patchPull(number, { base: { ref: "unexpected-base" } });
    };

    await expectUnconfirmedAutoMerge(harness);
    expect(harness.api.autoMergeRequests.get(42)).toBeUndefined();
    expect(harness.api.pulls.get(42)?.base).toEqual({ ref: "unexpected-base" });
    expectDisableWarning();
    await expectPublishedPull(harness);
  });

  it("traverses ownership label pages before and after enabling auto-merge", async () => {
    const harness = await makeHarness();
    useAutoMergeHttp(harness);

    await expect(runWithAutoMerge(harness)).resolves.toEqual({
      operation: "created",
      pullRequestNumber: 42,
    });
    expect(harness.api.autoMergeRequests.get(42)).toBe("SQUASH");
    await expectPublishedPull(harness);
  });

  it.each([
    {
      reason: "a null mutation payload",
      enableData: { enablePullRequestAutoMerge: null },
    },
    { reason: "a missing mutation payload", enableData: {} },
    {
      reason: "a missing auto-merge request",
      enableData: {
        enablePullRequestAutoMerge: {
          pullRequest: { id: "PR_42", autoMergeRequest: null },
        },
      },
    },
    {
      reason: "a mismatched mutation pull request",
      enableData: {
        enablePullRequestAutoMerge: {
          pullRequest: {
            id: "PR_41",
            autoMergeRequest: { mergeMethod: "SQUASH" },
          },
        },
      },
    },
    { reason: "a mismatched pull on revalidation", revalidatedId: "PR_41" },
    {
      reason: "a changed pull number on the last revalidation page",
      lastPageNumber: 43,
    },
  ])(
    "disables only the published pull's auto-merge after $reason",
    async (options) => {
      const harness = await makeHarness();
      const unrelated = { ...ownedPull(harness.oldSha), number: 41 };
      harness.api.pulls.set(41, {
        ...unrelated,
        head: { ...unrelated.head, ref: "unrelated" },
      });
      harness.api.autoMergeRequests.set(41, "SQUASH");
      useAutoMergeHttp(harness, options);

      await expectUnconfirmedAutoMerge(harness);
      expect(harness.api.autoMergeRequests.get(42)).toBeUndefined();
      expect(harness.api.autoMergeRequests.get(41)).toBe("SQUASH");
      expectDisableWarning();
      await expectPublishedPull(harness);
    },
  );

  it("reports when GitHub does not confirm that auto-merge was disabled", async () => {
    const harness = await makeHarness();
    useAutoMergeHttp(harness, {
      confirmDisable: false,
    });
    harness.api.transitions.afterEnableAutoMerge = (number) => {
      harness.api.patchPull(number, { base: { ref: "unexpected-base" } });
    };

    await expect(runWithAutoMerge(harness)).rejects.toMatchObject({
      publishedPullRequest: { operation: "created", pullRequestNumber: 42 },
      cause: expect.objectContaining({
        message:
          "Auto-merge revalidation failed and GitHub did not confirm that the request was disabled",
        cause: expect.objectContaining({
          errors: [
            expect.objectContaining({
              message: expect.stringContaining(
                "did not confirm squash auto-merge",
              ),
            }),
            expect.objectContaining({
              message: "GitHub did not confirm that auto-merge was disabled",
            }),
          ],
        }),
      }),
    });
    expect(harness.api.autoMergeRequests.get(42)).toBe("SQUASH");
    await expectPublishedPull(harness);
  });

  it("skips auto-merge when the token did not authenticate as a user", async () => {
    const harness = await makeHarness();
    const execution: ActionExecution = {
      ...harness.execution,
      context: {
        ...harness.execution.context,
        tokenAuthenticatedAsUser: false,
      },
      inputs: { ...harness.execution.inputs, autoMerge: true },
    };

    await expect(runUpdate(execution, harness.api)).resolves.toEqual({
      operation: "created",
      pullRequestNumber: 42,
    });
    expect(harness.api.autoMergeRequests.get(42)).toBeUndefined();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringMatching(/Skipping auto-merge.*provide a PAT/u),
    );
    await expectPublishedPull(harness);
  });

  it("preserves the pushed branch when create has an ambiguous outcome", async () => {
    const harness = await makeHarness();
    harness.api.transitions.beforeCreatePull = () => {
      throw restError("timeout", 504);
    };

    await expect(runUpdate(harness.execution, harness.api)).rejects.toThrow(
      /ambiguous outcome/u,
    );
    expect(await pushes(harness.log)).toHaveLength(1);
    expect([...harness.api.pulls.keys()]).toEqual([]);
  });

  it("recovers one exact ambiguous create result, labels it, and proves it", async () => {
    const harness = await makeHarness();
    harness.api.transitions.beforeCreatePull = async (request) => {
      await seedConcurrentPull(harness, request, 77);
      throw restError("timeout", 504);
    };

    await expect(runUpdate(harness.execution, harness.api)).resolves.toEqual({
      operation: "created",
      pullRequestNumber: 77,
    });
    expect(harness.api.pulls.get(77)).toMatchObject({
      state: "open",
      labels: [{ name: "dependencies" }],
      head: { sha: await remoteSha(harness.remote) },
    });
  });

  it.each(["nonexact", "multiple"] as const)(
    "preserves an ambiguous create with %s recovery candidates without labeling",
    async (variant) => {
      const harness = await makeHarness();
      harness.api.transitions.beforeCreatePull = async (request) => {
        await seedConcurrentPull(harness, request, 77);
        if (variant === "multiple")
          await seedConcurrentPull(harness, request, 78);
        else harness.api.patchPull(77, { body: "not the requested body" });
        throw restError("timeout", 504);
      };

      await expect(runUpdate(harness.execution, harness.api)).rejects.toThrow(
        /ambiguous outcome/u,
      );
      const sha = await remoteSha(harness.remote);
      for (const pull of harness.api.pulls.values()) {
        expect(pull).toMatchObject({
          state: "open",
          labels: [],
          head: { sha },
        });
      }
    },
  );

  it.each([
    ["label loss", { labels: [] }],
    ["body loss", { body: "human edit" }],
    ["state loss", { state: "closed" }],
    ["base loss", { base: { ref: "other" } }],
    [
      "head loss to a cleanup-prefix branch",
      {
        head: {
          ref: "chore/prek-old",
          repo: { full_name: "owner/repo" },
          sha: "OLD",
        },
      },
    ],
  ])(
    "does not push or patch after pre-push %s",
    async (_name, changed) => {
      const harness = await makeHarness({ existing: true });
      const patch =
        "head" in changed
          ? { ...changed, head: { ...changed.head, sha: harness.oldSha } }
          : changed;
      harness.api.transitions.afterListPulls = (state) => {
        if (state === "all") harness.api.patchPull(42, patch);
      };

      await expect(runUpdate(harness.execution, harness.api)).rejects.toThrow(
        /changed after initial observation/u,
      );
      expect(await pushes(harness.log)).toEqual([]);
      expect(harness.api.pulls.get(42)).toMatchObject(patch);
      expect(await remoteSha(harness.remote)).toBe(harness.oldSha);
    },
    15_000,
  );

  it("does not push or patch when the observed branch ref disappears before push", async () => {
    const harness = await makeHarness({ existing: true, refLoss: true });

    await expect(runUpdate(harness.execution, harness.api)).rejects.toThrow(
      /missing/u,
    );
    expect(await pushes(harness.log)).toEqual([]);
    expect(harness.api.pulls.get(42)?.body).toBe(BODY_MARKER);
    await expect(remoteSha(harness.remote)).rejects.toThrow();
  });

  it("rolls post-push proof loss back to the exact observed SHA without patching", async () => {
    const harness = await makeHarness({ existing: true, loseAfterPush: true });

    await expect(runUpdate(harness.execution, harness.api)).rejects.toThrow(
      /lease-rolled back/u,
    );
    const observedPushes = await pushes(harness.log);
    expect(observedPushes).toHaveLength(2);
    expect(observedPushes[1]).toContain(
      `${harness.oldSha}:refs/heads/chore/prek-updates`,
    );
    expect(observedPushes[1]).toMatch(
      /--force-with-lease=refs\/heads\/chore\/prek-updates:[0-9a-f]{40}/u,
    );
    expect(harness.api.pulls.get(42)).toMatchObject({
      labels: [],
      body: BODY_MARKER,
    });
    expect(await remoteSha(harness.remote)).toBe(harness.oldSha);
  });

  it("reports partial state when the post-push rollback lease fails", async () => {
    const harness = await makeHarness({ existing: true, loseAfterPush: true });
    process.env.TEST_GIT_FAIL_PUSH = "2";

    await expect(runUpdate(harness.execution, harness.api)).rejects.toThrow(
      /rollback also failed.*preserved/u,
    );
    expect(await pushes(harness.log)).toHaveLength(2);
    expect(harness.api.pulls.get(42)).toMatchObject({
      labels: [],
      body: BODY_MARKER,
      head: { sha: await remoteSha(harness.remote) },
    });
    expect(await remoteSha(harness.remote)).not.toBe(harness.oldSha);
  });

  it("rolls an existing branch back when pull metadata update fails", async () => {
    const harness = await makeHarness({ existing: true });
    harness.api.patchPull(42, { title: "Previous update" });
    harness.api.transitions.beforeUpdatePull = () => {
      throw new Error("timeout");
    };

    await expect(runUpdate(harness.execution, harness.api)).rejects.toThrow(
      /lease-rolled back/u,
    );
    expect(await remoteSha(harness.remote)).toBe(harness.oldSha);
    expect(harness.api.pulls.get(42)?.title).toBe("Previous update");
  });

  it("preserves the new branch when an applied metadata update cannot be verified", async () => {
    const harness = await makeHarness({ existing: true });
    harness.api.patchPull(42, { title: "Previous update" });
    harness.api.transitions.afterUpdatePull = ({ data }) => {
      data.body = "unexpected response";
      harness.api.transitions.beforeReadPull = () => {
        throw new Error("verification timeout");
      };
    };

    await expect(runUpdate(harness.execution, harness.api)).rejects.toThrow(
      /metadata outcome is ambiguous.*new branch was preserved/u,
    );
    expect(await remoteSha(harness.remote)).not.toBe(harness.oldSha);
    expect(harness.api.pulls.get(42)?.title).toBe("Update");
  });

  it("normalizes CRLF only when verifying unchanged original metadata", async () => {
    const harness = await makeHarness({ existing: true });
    harness.api.patchPull(42, { body: `${BODY_MARKER}\r\noriginal` });
    harness.api.transitions.beforeUpdatePull = () => {
      harness.api.patchPull(42, { body: `${BODY_MARKER}\noriginal` });
      throw new Error("timeout");
    };

    await expect(runUpdate(harness.execution, harness.api)).rejects.toThrow(
      /lease-rolled back/u,
    );
    expect(await remoteSha(harness.remote)).toBe(harness.oldSha);
    expect(harness.api.pulls.get(42)?.body).toBe(`${BODY_MARKER}\noriginal`);
  });

  it("normalizes CRLF when verifying freshly updated metadata", async () => {
    const harness = await makeHarness({ existing: true });
    await writeFile(
      harness.prek,
      "#!/bin/sh\nprintf 'updated\n' > prek.toml\nprintf 'detail\n'\n",
    );
    harness.api.transitions.afterUpdatePull = ({ data }) => {
      const body = String(data.body).replaceAll("\n", "\r\n");
      harness.api.patchPull(42, { body });
      data.body = "unexpected response";
    };

    await expect(runUpdate(harness.execution, harness.api)).resolves.toEqual({
      operation: "updated",
      pullRequestNumber: 42,
    });
    expect(harness.api.pulls.get(42)?.body).toContain("\r\ndetail\r\n");
  });

  it("reconciles a branch tied to one exact closed owned pull request", async () => {
    const harness = await makeHarness({ existing: true, closedExisting: true });

    await expect(runUpdate(harness.execution, harness.api)).resolves.toEqual({
      operation: "created",
      pullRequestNumber: 43,
    });
    expect(harness.api.pulls.get(42)).toMatchObject({
      state: "closed",
      head: { sha: harness.oldSha },
    });
    expect(harness.api.pulls.get(43)).toMatchObject({
      state: "open",
      labels: [{ name: "dependencies" }],
      head: { sha: await remoteSha(harness.remote) },
    });
  });

  it("preserves the update ref when the associated pull only matches the cleanup prefix", async () => {
    const harness = await makeHarness({ existing: true });
    const prefixPull = ownedPull(harness.oldSha);
    prefixPull.head.ref = "chore/prek-old";
    harness.api.pulls.set(42, prefixPull);

    await expect(runUpdate(harness.execution, harness.api)).rejects.toThrow(
      /not owned/u,
    );

    expect(await remoteSha(harness.remote)).toBe(harness.oldSha);
    expect([...harness.api.pulls.values()]).toEqual([prefixPull]);
    expect(harness.api.pulls.get(42)?.body).toBe(BODY_MARKER);
  });

  it("preserves a created branch when closing after label failure fails", async () => {
    const harness = await makeHarness();
    harness.api.transitions.beforeAddLabel = () => {
      throw new Error("label failed");
    };
    harness.api.transitions.beforeUpdatePull = () => {
      throw new Error("close failed");
    };

    await expect(runUpdate(harness.execution, harness.api)).rejects.toThrow(
      /closing it also failed.*branch was preserved/u,
    );
    expect(harness.api.pulls.get(42)).toMatchObject({
      state: "open",
      labels: [],
      head: { sha: await remoteSha(harness.remote) },
    });
  });

  it("closes a created pull before lease-deleting after label failure", async () => {
    const harness = await makeHarness();
    harness.api.transitions.beforeAddLabel = () => {
      throw new Error("label failed");
    };
    harness.api.transitions.afterClosePull = async () => {
      // Keep an open pull's branch available until closure is confirmed.
      await expect(remoteSha(harness.remote)).resolves.toMatch(
        /^[0-9a-f]{40}$/u,
      );
    };

    await expect(runUpdate(harness.execution, harness.api)).rejects.toThrow(
      /closed and its branch was lease-rolled back/u,
    );
    expect(harness.api.pulls.get(42)).toMatchObject({
      state: "closed",
      labels: [],
    });
    await expect(remoteSha(harness.remote)).rejects.toThrow();
  });

  it("accepts an unexpected update response only after an exact fresh GET", async () => {
    const harness = await makeHarness({ existing: true });
    harness.api.patchPull(42, {
      title: "Previous update",
      body: `${BODY_MARKER}\nPrevious body`,
    });
    harness.api.transitions.afterUpdatePull = ({ data }) => {
      data.body = "unexpected response";
    };

    await expect(runUpdate(harness.execution, harness.api)).resolves.toEqual({
      operation: "updated",
      pullRequestNumber: 42,
    });
    expect(harness.api.pulls.get(42)).toMatchObject({
      state: "open",
      title: "Update",
      body: BODY_MARKER,
      head: { sha: await remoteSha(harness.remote) },
    });
  });

  it("does not close or delete an existing pull when cached diff errors", async () => {
    const harness = await makeHarness({ existing: true, noChange: true });
    process.env.TEST_GIT_FAIL_DIFF = "1";

    await expect(runUpdate(harness.execution, harness.api)).rejects.toThrow(
      /diff --cached --quiet failed/u,
    );
    expect(harness.api.pulls.get(42)?.state).toBe("open");
    expect(await remoteSha(harness.remote)).toBe(harness.oldSha);
    expect(await pushes(harness.log)).toEqual([]);
  });

  it("does not persist the bot commit identity in repository config", async () => {
    const harness = await makeHarness({ existing: true });
    await runUpdate(harness.execution, harness.api);

    expect(
      (
        await exec("git", [
          "-C",
          harness.execution.context.workspace,
          "config",
          "user.name",
        ])
      ).stdout.trim(),
    ).toBe("Test");
    expect(
      (
        await exec("git", [
          "-C",
          harness.execution.context.workspace,
          "config",
          "user.email",
        ])
      ).stdout.trim(),
    ).toBe("test@example.com");
  });

  it.each([
    ["before the run", "before"],
    ["during the run", "during"],
  ] as const)(
    "prevents mutation when the base ref drifts %s",
    async (_name, baseDrift) => {
      const harness = await makeHarness({ baseDrift });

      await expect(runUpdate(harness.execution, harness.api)).rejects.toThrow(
        /base branch changed/u,
      );
      expect(await pushes(harness.log)).toEqual([]);
      expect([...harness.api.pulls.keys()]).toEqual([]);
    },
  );
});

describe("detached caller checkout", () => {
  it("refuses a stale detached checkout with an actionable message and no mutation", async () => {
    const harness = await makeHarness({ detached: true, baseDrift: "before" });
    expect(
      (
        await exec("git", [
          "-C",
          harness.execution.context.workspace,
          "branch",
          "--show-current",
        ])
      ).stdout.trim(),
    ).toBe("");

    const error = await runUpdate(harness.execution, harness.api).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toMatch(/base branch changed after checkout/u);
    expect(message).toContain("DRIFT");
    expect(message).toContain(harness.execution.context.baseSha);
    expect(await pushes(harness.log)).toEqual([]);
    expect([...harness.api.pulls.keys()]).toEqual([]);
  });

  it("proceeds from a detached checkout at the branch tip", async () => {
    const harness = await makeHarness({
      detached: true,
      existing: true,
      noChange: true,
    });
    await expect(
      runUpdate(harness.execution, harness.api),
    ).resolves.toMatchObject({
      operation: "closed",
    });
  });
});

describe("no-change close compensation", () => {
  it("returns the closed pull and deleted branch for reporting", async () => {
    const harness = await makeHarness({ existing: true, noChange: true });
    await expect(runUpdate(harness.execution, harness.api)).resolves.toEqual({
      operation: "closed",
      cleanup: {
        closedPullRequests: [42],
        deletedBranches: ["chore/prek-updates"],
      },
    });
    expect(harness.api.pulls.get(42)?.state).toBe("closed");
    await expect(remoteSha(harness.remote)).rejects.toThrow();
  });

  it("preserves the branch and refuses reopen when close response loses identity", async () => {
    const harness = await makeHarness({ existing: true, noChange: true });
    harness.api.transitions.afterClosePull = () => {
      harness.api.patchPull(42, { body: "changed" });
    };
    harness.api.transitions.afterUpdatePull = ({ data }) => {
      data.body = "changed";
    };

    await expect(runUpdate(harness.execution, harness.api)).rejects.toThrow(
      /unexpected pull request after close/u,
    );
    expect(await pushes(harness.log)).toEqual([]);
    expect(harness.api.pulls.get(42)?.state).toBe("closed");
    expect(await remoteSha(harness.remote)).toBe(harness.oldSha);
  });

  it("reopens only the exact unchanged close event with its ETag after delete failure", async () => {
    const harness = await makeHarness({ existing: true, noChange: true });
    process.env.TEST_GIT_FAIL_PUSH = "1";

    await expect(runUpdate(harness.execution, harness.api)).rejects.toThrow(
      /was compensated/u,
    );
    expect(harness.api.pulls.get(42)?.state).toBe("open");
    expect(await remoteSha(harness.remote)).toBe(harness.oldSha);
  });

  it("leaves the pull closed when its ETag changes before the conditional reopen", async () => {
    const harness = await makeHarness({ existing: true, noChange: true });
    process.env.TEST_GIT_FAIL_PUSH = "1";
    harness.api.transitions.beforeUpdatePull = ({ number, changes }) => {
      if ("state" in changes && changes.state === "open") {
        harness.api.pullEtags.set(number, '"concurrent-edit"');
      }
    };

    await expect(runUpdate(harness.execution, harness.api)).rejects.toThrow(
      /was not reopened/u,
    );
    expect(harness.api.pulls.get(42)?.state).toBe("closed");
    expect(await remoteSha(harness.remote)).toBe(harness.oldSha);
  });

  it.each([
    ["changed timestamp", { updated_at: "2026-07-28T00:00:02Z" }],
    ["changed closed_at", { closed_at: "2026-07-28T00:00:02Z" }],
    ["changed ownership", { labels: [] }],
  ])("never reopens after %s", async (_name, changed) => {
    const harness = await makeHarness({ existing: true, noChange: true });
    process.env.TEST_GIT_FAIL_PUSH = "1";
    harness.api.transitions.afterClosePull = () => {
      harness.api.patchPull(42, changed);
    };

    await expect(runUpdate(harness.execution, harness.api)).rejects.toThrow(
      /was not reopened/u,
    );
    expect(harness.api.pulls.get(42)?.state).toBe("closed");
    expect(await remoteSha(harness.remote)).toBe(harness.oldSha);
  });
});

it("preserves a cleanup ref and discards credentials from a rejected push error", async () => {
  const token = "fake-cleanup-credential";
  const harness = await makeHarness({
    existing: true,
    closedExisting: true,
    token,
  });
  process.env.TEST_GIT_FAIL_PUSH = "1";
  process.env.TEST_GIT_FAILURE_OUTPUT = token;

  const error = await cleanupWithApi(harness.api, harness.execution, {
    keepLatestOpenPullRequest: false,
    closeStalePullRequests: false,
    closeObsoletePullRequests: false,
    deleteStaleBranches: true,
    deleteMergedBranches: false,
  }).catch((caught: unknown) => caught);

  expect(error).toMatchObject({
    message: expect.stringContaining("Lease-protected branch deletion failed"),
  });
  const errorText = inspect(error, { depth: null });
  expect(errorText).not.toContain(token);
  expect(errorText).not.toContain(
    Buffer.from(`x-access-token:${token}`).toString("base64"),
  );
  expect(await remoteSha(harness.remote)).toBe(harness.oldSha);
});

interface HarnessOptions {
  existing?: boolean;
  closedExisting?: boolean;
  noChange?: boolean;
  loseAfterPush?: boolean;
  baseDrift?: "before" | "during";
  serverUrl?: string;
  token?: string;
  detached?: boolean;
  refLoss?: boolean;
}

async function makeHarness(options: HarnessOptions = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "prek-update-race-"));
  cleanups.push(root);
  const workspace = path.join(root, "workspace");
  const remote = path.join(root, "remote.git");
  const bin = path.join(root, "bin");
  const log = path.join(root, "git.log");
  await writeFile(log, "");
  await exec("git", ["init", "-b", "main", workspace]);
  await exec("git", ["-C", workspace, "config", "user.name", "Test"]);
  await exec("git", [
    "-C",
    workspace,
    "config",
    "user.email",
    "test@example.com",
  ]);
  await writeFile(path.join(workspace, "prek.toml"), "base\n");
  await exec("git", ["-C", workspace, "add", "."]);
  await exec("git", ["-C", workspace, "commit", "-m", "base"]);
  const baseSha = (
    await exec("git", ["-C", workspace, "rev-parse", "HEAD"])
  ).stdout.trim();
  await exec("git", ["init", "--bare", remote]);
  await exec("git", ["-C", workspace, "push", remote, "main"]);
  if (options.detached) {
    await exec("git", ["-C", workspace, "checkout", "--detach", baseSha]);
  }
  let oldSha = "";
  if (options.existing) {
    await exec("git", [
      "-C",
      workspace,
      "branch",
      "chore/prek-updates",
      baseSha,
    ]);
    await exec("git", ["-C", workspace, "push", remote, "chore/prek-updates"]);
    oldSha = baseSha;
  }
  await installGitProxy(bin);
  process.env.PATH = `${bin}:${originalPath}`;
  process.env.TEST_GIT_LOG = log;
  process.env.TEST_GIT_REMOTE = remote;

  const prek = path.join(root, "prek");
  await writeFile(
    prek,
    options.noChange
      ? "#!/bin/sh\nexit 0\n"
      : "#!/bin/sh\nprintf 'updated\\n' > prek.toml\n",
  );
  await chmod(prek, 0o755);
  installPrek.mockResolvedValue({
    binary: prek,
    cleanup: async () => undefined,
  });

  const pull = ownedPull(oldSha);
  if (options.closedExisting) {
    pull.state = "closed";
    pull.closed_at = "2026-07-28T00:00:00Z";
  }
  const api = new InMemoryGitHub(options.existing ? [pull] : []);
  api.labels.set("dependencies", "0366d6");
  api.refs.set(
    "heads/main",
    options.baseDrift === "before" ? "DRIFT" : baseSha,
  );
  let removeRef: Promise<unknown> | undefined;
  api.transitions.beforeReadRef = async (ref) => {
    if (ref !== updateRef) return;
    await removeRef;
    const { stdout } = await exec("git", [
      "ls-remote",
      "--refs",
      remote,
      `refs/${ref}`,
    ]);
    const sha = stdout.split("\t")[0];
    if (sha) api.refs.set(ref, sha);
    else api.refs.delete(ref);
  };
  api.transitions.beforeReadPull = async (number) => {
    const current = api.pulls.get(number);
    if (current === undefined || current.state !== "open") return;
    const head = current.head as typeof pull.head;
    if (head.ref !== updateBranch) return;
    if (options.refLoss) {
      removeRef ??= exec("git", [
        "--git-dir",
        remote,
        "update-ref",
        "-d",
        `refs/${updateRef}`,
        oldSha,
      ]);
    }
    const sha = await api.getRefSha(updateRef);
    if (sha === undefined) return;
    api.patchPull(number, {
      head: { ...head, sha },
      ...(options.loseAfterPush && sha !== oldSha ? { labels: [] } : {}),
    });
  };
  if (options.baseDrift === "during") {
    api.transitions.afterListPulls = () => {
      api.refs.set("heads/main", "DRIFT");
    };
  }
  const execution = {
    client: {} as GitHubClient,
    context: {
      authenticatedLogin: "github-actions[bot]",
      tokenAuthenticatedAsUser: true,
      baseBranch: "main",
      baseSha,
      eventName: "schedule",
      owner: "owner",
      repository: "repo",
      repositoryFullName: "owner/repo",
      serverUrl: options.serverUrl ?? "https://github.com",
      workspace,
    },
    inputs: {
      addPaths: ["prek.toml"],
      autoMerge: false,
      authorLogin: "github-actions[bot]",
      branchPrefix: "chore/prek-",
      commitMessage: "update",
      cooldownDays: "7",
      label: "dependencies",
      prTitle: "Update",
      token: options.token ?? "token",
      updateBranch: "chore/prek-updates",
      updateDay: 1,
    },
  } satisfies ActionExecution;
  process.env.TEST_GIT_URL = `${execution.context.serverUrl}/${execution.context.repositoryFullName}.git`;
  api.deleteRef = (ref, expectedSha, workspace) =>
    deleteBranch({
      remote: {
        serverUrl: execution.context.serverUrl,
        token: execution.inputs.token,
        repositoryFullName: execution.context.repositoryFullName,
      },
      ref: `refs/${ref}`,
      expectedSha,
      readRef: () => api.getRefSha(ref),
      ...(workspace === undefined ? {} : { workspace }),
    });
  return {
    api,
    execution: { ...execution, api },
    log,
    oldSha,
    prek,
    remote,
  };
}

async function makeWorktreeHarness(scratchName = "worktree-tmp") {
  const { execution, log } = await makeHarness({ noChange: true });
  const { workspace } = execution.context;
  const scratch = path.join(path.dirname(log), scratchName);
  await mkdir(scratch);
  vi.stubEnv("TMPDIR", scratch);
  process.env.TEST_GIT_WORKTREE_REMOVE_SENTINEL = `${log}.worktree`;
  return { execution, initial: await worktrees(workspace), scratch, workspace };
}

async function installGitProxy(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const realGit = (await exec("which", ["git"])).stdout.trim();
  await writeFile(
    path.join(directory, "git"),
    `#!/bin/sh
args=""
for arg in "$@"; do
  [ "$arg" = "$TEST_GIT_URL" ] && arg="$TEST_GIT_REMOTE"
  args="$args '$arg'"
done
case " $* " in
  *" worktree add --detach "*)
    [ "$TEST_GIT_FAIL_WORKTREE_ADD_BEFORE" = "1" ] && exit 1
    if [ "$TEST_GIT_FAIL_WORKTREE_ADD_AFTER" = "1" ]; then
      eval ${JSON.stringify(realGit)} "$args" || exit $?
      exit 1
    fi
    ;;
  *" worktree remove --force "*)
    if [ -n "$TEST_GIT_FAIL_WORKTREE_REMOVE" ]; then
      if [ ! -e "$TEST_GIT_WORKTREE_REMOVE_SENTINEL" ]; then
        : > "$TEST_GIT_WORKTREE_REMOVE_SENTINEL"
        if [ "$TEST_GIT_LOCK_WORKTREE_ON_REMOVE" = "1" ]; then
          for worktree do :; done
          ${JSON.stringify(realGit)} -C "$worktree" worktree lock "$worktree" || exit $?
        fi
        if [ "$TEST_GIT_UNREGISTER_WORKTREE_ON_REMOVE" = "1" ]; then
          eval ${JSON.stringify(realGit)} "$args" || exit $?
        fi
        exit 1
      fi
      [ "$TEST_GIT_FAIL_WORKTREE_REMOVE" = "always" ] && exit 1
    fi
    ;;
  *" worktree list --porcelain -z "*)
    [ "$TEST_GIT_FAIL_WORKTREE_LIST" = "1" ] && exit 1
    if [ "$TEST_GIT_LEGACY_WORKTREE_LIST" = "1" ]; then
      printf "%s\\n" "error: unknown switch \\\`z'" \\
        "usage: git worktree add [<options>] <path> [<commit-ish>]" \\
        "   or: git worktree list [<options>]" >&2
      exit 129
    fi
    ;;
  *" diff --cached --quiet "*)
    [ "$TEST_GIT_FAIL_DIFF" = "1" ] && exit 2
    ;;
  *" push "*)
    printf '%s\\n' "$*" >> "$TEST_GIT_LOG"
    count=$(wc -l < "$TEST_GIT_LOG" | tr -d ' ')
    if [ "$count" = "$TEST_GIT_FAIL_PUSH" ]; then
      printf '%s\\n' "$TEST_GIT_FAILURE_OUTPUT" >&2
      exit 1
    fi
    ;;
esac
eval exec ${JSON.stringify(realGit)} "$args"
`,
  );
  await chmod(path.join(directory, "git"), 0o755);
}

async function pushes(log: string): Promise<string[]> {
  const value = await readFile(log, "utf8");
  return value.trim().split("\n").filter(Boolean);
}

async function worktrees(workspace: string): Promise<string[]> {
  const result = await exec("git", [
    "-C",
    workspace,
    "worktree",
    "list",
    "--porcelain",
    "-z",
  ]);
  return result.stdout
    .split("\0")
    .filter((entry) => entry.startsWith("worktree "))
    .map((entry) => entry.slice("worktree ".length));
}

async function remoteSha(remote: string): Promise<string> {
  return (
    await exec("git", [
      "--git-dir",
      remote,
      "rev-parse",
      "refs/heads/chore/prek-updates",
    ])
  ).stdout.trim();
}

async function seedConcurrentPull(
  harness: Awaited<ReturnType<typeof makeHarness>>,
  request: NewPull,
  number: number,
): Promise<void> {
  harness.api.pulls.set(number, {
    ...ownedPull(await remoteSha(harness.remote)),
    title: request.title,
    body: request.body,
    number,
    labels: [],
  });
}

function restError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

async function expectPublishedPull(
  { api, remote }: Awaited<ReturnType<typeof makeHarness>>,
  state = "open",
  sha?: string,
): Promise<void> {
  const pull = api.pulls.get(42);
  expect(pull).toMatchObject({ state });
  const revision = await remoteSha(remote);
  expect(revision).not.toBe("");
  expect(revision).toBe(sha ?? (pull?.head as { sha: string }).sha);
}

interface AutoMergeHttpOptions {
  readonly enableData?: object;
  readonly revalidatedId?: string;
  readonly lastPageNumber?: number;
  readonly confirmDisable?: boolean;
}

// Run the three auto-merge operations through real Octokit against a simulated
// GraphQL endpoint backed by the same repository state as the REST operations.
function useAutoMergeHttp(
  { api, execution }: Awaited<ReturnType<typeof makeHarness>>,
  options: AutoMergeHttpOptions = {},
): void {
  const getAutoMergePull = api.getAutoMergePull.bind(api);
  const enableSquashAutoMerge = api.enableSquashAutoMerge.bind(api);
  const disableAutoMerge = api.disableAutoMerge.bind(api);
  const client = getOctokit(execution.inputs.token, {
    request: {
      fetch: async (url: string, request?: RequestInit): Promise<Response> => {
        if (new URL(url).pathname !== "/graphql" || request?.method !== "POST")
          return Response.json(
            { message: "Unexpected request" },
            { status: 404 },
          );
        const { query, variables } = JSON.parse(String(request.body)) as {
          query: string;
          variables: {
            number: number;
            pullRequestId: string;
            expectedHeadOid: string;
            labelsCursor: string | null;
          };
        };
        const id = variables.pullRequestId;
        const autoMergeRequest = (mergeMethod: string | undefined) =>
          mergeMethod === undefined
            ? null
            : { mergeMethod, enabledAt: "2026-08-23T12:00:00Z" };

        if (query.includes("enablePullRequestAutoMerge(")) {
          await enableSquashAutoMerge(id, variables.expectedHeadOid);
          return Response.json({
            data: options.enableData ?? {
              enablePullRequestAutoMerge: {
                pullRequest: {
                  id,
                  autoMergeRequest: autoMergeRequest("SQUASH"),
                },
              },
            },
          });
        }
        if (query.includes("disablePullRequestAutoMerge(")) {
          if (options.confirmDisable !== false) await disableAutoMerge(id);
          return Response.json({
            data: {
              disablePullRequestAutoMerge: {
                pullRequest: {
                  id,
                  autoMergeRequest: autoMergeRequest(
                    api.autoMergeRequests.get(Number(id.slice(3))),
                  ),
                },
              },
            },
          });
        }

        const pull = await getAutoMergePull(variables.number);
        if (pull === null)
          return Response.json({ data: { repository: { pullRequest: null } } });
        const cursor =
          pull.mergeMethod === undefined ? "before-enable" : "after-enable";
        const firstPage = variables.labelsCursor === null;
        if (!firstPage && variables.labelsCursor !== cursor)
          return Response.json({
            errors: [{ message: "Invalid label cursor" }],
          });
        return Response.json({
          data: {
            repository: {
              pullRequest: {
                id:
                  pull.mergeMethod === undefined
                    ? pull.id
                    : (options.revalidatedId ?? pull.id),
                number:
                  !firstPage && pull.mergeMethod !== undefined
                    ? (options.lastPageNumber ?? pull.number)
                    : pull.number,
                state: pull.state,
                headRefOid: pull.headSha,
                author: { login: pull.author },
                body: pull.body,
                headRefName: pull.headRef,
                headRepository: { nameWithOwner: pull.headRepository },
                baseRefName: pull.baseRef,
                autoMergeRequest: autoMergeRequest(pull.mergeMethod),
                labels: {
                  nodes: firstPage
                    ? [{ name: "unrelated" }]
                    : pull.labels.map((name) => ({ name })),
                  pageInfo: {
                    hasNextPage: firstPage,
                    endCursor: firstPage ? cursor : null,
                  },
                },
              },
            },
          },
        });
      },
    },
  });
  const production = new OctokitGitHubApi(
    client,
    execution.context.owner,
    execution.context.repository,
    execution.inputs.token,
    execution.context.serverUrl,
  );
  api.getAutoMergePull = production.getAutoMergePull.bind(production);
  api.enableSquashAutoMerge = production.enableSquashAutoMerge.bind(production);
  api.disableAutoMerge = production.disableAutoMerge.bind(production);
}

function runWithAutoMerge(harness: Awaited<ReturnType<typeof makeHarness>>) {
  return runUpdate(
    {
      ...harness.execution,
      inputs: { ...harness.execution.inputs, autoMerge: true },
    },
    harness.api,
  );
}

async function expectUnconfirmedAutoMerge(
  harness: Awaited<ReturnType<typeof makeHarness>>,
): Promise<void> {
  await expect(runWithAutoMerge(harness)).rejects.toMatchObject({
    publishedPullRequest: { operation: "created", pullRequestNumber: 42 },
    cause: expect.objectContaining({
      message:
        "GitHub did not confirm squash auto-merge for the exact pull-request revision",
    }),
  });
}

function expectDisableWarning(): void {
  expect(core.warning).toHaveBeenCalledWith(
    "Disabled an auto-merge request after pull-request ownership revalidation failed",
  );
}

function ownedPull(sha: string) {
  return {
    base: { ref: "main" },
    body: BODY_MARKER,
    closed_at: null as string | null,
    head: { ref: "chore/prek-updates", repo: { full_name: "owner/repo" }, sha },
    labels: [{ name: "dependencies" }],
    number: 42,
    state: "open",
    title: "Update",
    updated_at: "2026-07-28T00:00:01Z",
    user: { login: "github-actions[bot]" },
  };
}

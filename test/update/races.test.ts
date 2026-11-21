import * as core from "@actions/core";
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

import { cleanupUpdateBranches } from "../../src/cleanup/index.js";
import type { ActionExecution, GitHubClient } from "../../src/contracts.js";
import { BODY_MARKER } from "../../src/ownership.js";
import { runUpdate } from "../../src/update/index.js";

const exec = promisify(execFile);
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
  it("cleans an ordinary pre-registration worktree add failure", async () => {
    const { execution, initial, scratch, workspace } =
      await makeWorktreeHarness();
    process.env.TEST_GIT_FAIL_WORKTREE_ADD_BEFORE = "1";

    const error = await runUpdate(execution).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AggregateError);
    expect(await worktrees(workspace)).toEqual(initial);
    expect(await readdir(scratch)).toEqual([]);
  });

  it("cleans a partially successful worktree add", async () => {
    const { execution, initial, scratch, workspace } =
      await makeWorktreeHarness();
    process.env.TEST_GIT_FAIL_WORKTREE_ADD_AFTER = "1";

    await expect(runUpdate(execution)).rejects.toThrow();

    expect(await worktrees(workspace)).toEqual(initial);
    expect(await readdir(scratch)).toEqual([]);
  });

  it("retries worktree removal after a transient failure", async () => {
    const { execution, initial, scratch, workspace } =
      await makeWorktreeHarness();
    process.env.TEST_GIT_FAIL_WORKTREE_REMOVE = "once";

    await expect(runUpdate(execution)).resolves.toEqual({ operation: "none" });

    expect(await worktrees(workspace)).toEqual(initial);
    expect(await readdir(scratch)).toEqual([]);
  });

  it.each([
    { scenario: "a path containing a newline", scratchName: "worktree\ntmp" },
    {
      scenario: "failed registration inspection",
      scratchName: "worktree-tmp",
      inspectionFails: true,
    },
  ])(
    "preserves a registered worktree after persistent removal failure with $scenario",
    async ({ scratchName, inspectionFails }) => {
      const { execution, initial, workspace } =
        await makeWorktreeHarness(scratchName);
      process.env.TEST_GIT_FAIL_WORKTREE_REMOVE = "always";
      if (inspectionFails) {
        process.env.TEST_GIT_FAIL_WORKTREE_LIST = "1";
      }

      await expect(runUpdate(execution)).rejects.toMatchObject({
        message: "Update operation completed but cleanup failed",
        errors: [
          expect.objectContaining({
            message: expect.stringContaining(
              inspectionFails
                ? "Failed to reconcile action-owned worktree registration"
                : "Failed to remove action-owned worktree",
            ),
          }),
        ],
      });

      delete process.env.TEST_GIT_FAIL_WORKTREE_LIST;
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

    await expect(runUpdate(execution)).rejects.toMatchObject({
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

    await expect(runUpdate(execution)).resolves.toEqual({ operation: "none" });

    expect(await worktrees(workspace)).toEqual(initial);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        "registration was already absent; continuing cleanup",
      ),
    );
    expect(await readdir(scratch)).toEqual([]);
  });

  it("scopes authenticated pushes to the configured Actions server", async () => {
    const harness = await makeHarness();
    const serverUrl = "https://github.example.com";
    const execution: ActionExecution = {
      ...harness.execution,
      context: { ...harness.execution.context, serverUrl },
    };
    process.env.TEST_GIT_URL = `${serverUrl}/owner/repo.git`;
    harness.create.mockRejectedValue(
      Object.assign(new Error("bad"), { status: 422 }),
    );

    await expect(runUpdate(execution)).rejects.toThrow(/lease-rolled back/u);
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
    harness.create.mockRejectedValue(
      Object.assign(new Error("bad"), { status: 422 }),
    );

    await expect(runUpdate(harness.execution)).rejects.toThrow(
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
    expect(harness.update).not.toHaveBeenCalled();
  });

  it("reports a branch already absent after a definite create failure", async () => {
    const harness = await makeHarness();
    harness.create.mockImplementationOnce(async () => {
      await exec("git", [
        "--git-dir",
        harness.remote,
        "update-ref",
        "-d",
        "refs/heads/chore/prek-updates",
        await remoteSha(harness.remote),
      ]);
      throw Object.assign(new Error("bad"), { status: 422 });
    });

    await expect(runUpdate(harness.execution)).rejects.toThrow(
      /creation failed.*branch was already absent/u,
    );
    await expect(remoteSha(harness.remote)).rejects.toThrow();
  });

  it("preserves a moved ref when a definite create failure triggers rollback", async () => {
    const harness = await makeHarness();
    const movedSha = harness.execution.context.baseSha;
    harness.create.mockImplementationOnce(async () => {
      await exec("git", [
        "--git-dir",
        harness.remote,
        "update-ref",
        "refs/heads/chore/prek-updates",
        movedSha,
        await remoteSha(harness.remote),
      ]);
      throw Object.assign(new Error("bad"), { status: 422 });
    });

    await expect(runUpdate(harness.execution)).rejects.toMatchObject({
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
    harness.create.mockRejectedValue(
      Object.assign(new Error("already exists"), { status: 422 }),
    );
    harness.paginate.mockResolvedValueOnce([]).mockImplementation(async () => [
      mergePull(harness.pull, {
        number: 77,
        head: {
          ...harness.pull.head,
          sha: await remoteSha(harness.remote),
        },
      }),
    ]);
    harness.get.mockImplementation(async () => ({
      data: mergePull(harness.pull, {
        number: 77,
        head: {
          ...harness.pull.head,
          sha: await remoteSha(harness.remote),
        },
      }),
      headers: { etag: '"created"' },
    }));

    await expect(runUpdate(harness.execution)).resolves.toEqual({
      operation: "created",
      pullRequestNumber: 77,
    });
    expect(await pushes(harness.log)).toHaveLength(1);
  });

  it("enables auto-merge after proving the exact created pull revision", async () => {
    const harness = await makeHarness();
    harness.create.mockImplementation(async () => ({
      data: mergePull(harness.pull, {
        head: {
          ...harness.pull.head,
          sha: await remoteSha(harness.remote),
        },
      }),
    }));
    const execution: ActionExecution = {
      ...harness.execution,
      inputs: { ...harness.execution.inputs, autoMerge: true },
    };
    harness.graphql.mockImplementation(
      async (_document: string, variables: Record<string, unknown>) => {
        const headRefOid = await remoteSha(harness.remote);
        const enabling = "expectedHeadOid" in variables;
        const pullRequest = autoMergePull(headRefOid, enabling);
        return enabling
          ? {
              enablePullRequestAutoMerge: {
                pullRequest: {
                  id: pullRequest.id,
                  autoMergeRequest: pullRequest.autoMergeRequest,
                },
              },
            }
          : { repository: { pullRequest } };
      },
    );

    await expect(runUpdate(execution)).resolves.toEqual({
      operation: "created",
      pullRequestNumber: 42,
    });

    expect(harness.create).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("Automated update of `prek` hooks."),
      }),
    );
    expect(harness.graphql).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        expectedHeadOid: await remoteSha(harness.remote),
      }),
    );
  });

  it.each([
    ["a prefix-only head branch", { headRefName: "chore/prek-old" }],
    ["a closed pull request", { state: "CLOSED" }],
  ])(
    "preserves the published update without enabling auto-merge on %s",
    async (_reason, overrides) => {
      const harness = await makeHarness();
      harness.create.mockImplementation(async () => ({
        data: mergePull(harness.pull, {
          head: { ...harness.pull.head, sha: await remoteSha(harness.remote) },
        }),
      }));
      let publishedSha: string | undefined;
      let autoMergeEnabled = false;
      harness.graphql.mockImplementation(
        async (_document: string, variables: Record<string, unknown>) => {
          publishedSha = await remoteSha(harness.remote);
          if ("expectedHeadOid" in variables) autoMergeEnabled = true;
          return {
            repository: {
              pullRequest: { ...autoMergePull(publishedSha), ...overrides },
            },
          };
        },
      );

      await expect(
        runUpdate({
          ...harness.execution,
          inputs: { ...harness.execution.inputs, autoMerge: true },
        }),
      ).rejects.toMatchObject({
        publishedPullRequest: { operation: "created", pullRequestNumber: 42 },
        cause: expect.objectContaining({
          message:
            "Pull request changed before squash auto-merge could be enabled",
        }),
      });
      expect(autoMergeEnabled).toBe(false);
      expect(await remoteSha(harness.remote)).toBe(publishedSha);
    },
  );

  it.each([
    { existing: false, operation: "created" },
    { existing: true, operation: "updated" },
  ] as const)(
    "reports the $operation pull when auto-merge fails",
    async ({ existing, operation }) => {
      const harness = await makeHarness({ existing });
      if (!existing) {
        harness.create.mockImplementation(async () => ({
          data: mergePull(harness.pull, {
            head: {
              ...harness.pull.head,
              sha: await remoteSha(harness.remote),
            },
          }),
        }));
      }
      const execution: ActionExecution = {
        ...harness.execution,
        inputs: { ...harness.execution.inputs, autoMerge: true },
      };
      harness.graphql
        .mockImplementationOnce(async () => ({
          repository: {
            pullRequest: autoMergePull(await remoteSha(harness.remote)),
          },
        }))
        .mockRejectedValueOnce(new Error("auto-merge rejected"));

      const error = await runUpdate(execution).catch(
        (caught: unknown) => caught,
      );

      expect(error).toMatchObject({
        publishedPullRequest: { operation, pullRequestNumber: 42 },
      });
    },
  );

  it("does not attempt auto-merge when the token is not a PAT", async () => {
    const harness = await makeHarness();
    harness.create.mockImplementation(async () => ({
      data: mergePull(harness.pull, {
        head: {
          ...harness.pull.head,
          sha: await remoteSha(harness.remote),
        },
      }),
    }));
    const execution: ActionExecution = {
      ...harness.execution,
      context: {
        ...harness.execution.context,
        tokenAuthenticatedAsUser: false,
      },
      inputs: { ...harness.execution.inputs, autoMerge: true },
    };

    await expect(runUpdate(execution)).resolves.toEqual({
      operation: "created",
      pullRequestNumber: 42,
    });

    expect(harness.graphql).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringMatching(/Skipping auto-merge.*provide a PAT/u),
    );
  });

  it("preserves the pushed branch when create has an ambiguous outcome", async () => {
    const harness = await makeHarness();
    harness.create.mockRejectedValue(
      Object.assign(new Error("timeout"), { status: 504 }),
    );

    await expect(runUpdate(harness.execution)).rejects.toThrow(
      /ambiguous outcome/u,
    );
    expect(await pushes(harness.log)).toHaveLength(1);
    expect(harness.update).not.toHaveBeenCalled();
  });

  it("recovers one exact ambiguous create result, labels it, and proves it", async () => {
    const harness = await makeHarness();
    harness.create.mockRejectedValue(
      Object.assign(new Error("timeout"), { status: 504 }),
    );
    harness.paginate.mockResolvedValueOnce([]).mockImplementation(async () => [
      mergePull(harness.pull, {
        number: 77,
        head: {
          ...harness.pull.head,
          sha: await remoteSha(harness.remote),
        },
      }),
    ]);
    harness.get.mockImplementation(async () => ({
      data: mergePull(harness.pull, {
        number: 77,
        head: {
          ...harness.pull.head,
          sha: await remoteSha(harness.remote),
        },
      }),
      headers: { etag: '"created"' },
    }));

    await expect(runUpdate(harness.execution)).resolves.toEqual({
      operation: "created",
      pullRequestNumber: 77,
    });
    expect(harness.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 77,
        labels: ["dependencies"],
      }),
    );
    expect(await pushes(harness.log)).toHaveLength(1);
  });

  it.each(["nonexact", "multiple"] as const)(
    "preserves an ambiguous create with %s recovery candidates without labeling",
    async (variant) => {
      const harness = await makeHarness();
      harness.create.mockRejectedValue(
        Object.assign(new Error("timeout"), { status: 504 }),
      );
      harness.paginate
        .mockResolvedValueOnce([])
        .mockImplementation(async () => {
          const exact = mergePull(harness.pull, {
            number: 77,
            head: {
              ...harness.pull.head,
              sha: await remoteSha(harness.remote),
            },
          });
          return variant === "multiple"
            ? [exact, mergePull(exact, { number: 78 })]
            : [mergePull(exact, { body: "not the requested body" })];
        });

      await expect(runUpdate(harness.execution)).rejects.toThrow(
        /ambiguous outcome/u,
      );
      expect(harness.addLabels).not.toHaveBeenCalled();
      expect(harness.get).not.toHaveBeenCalled();
      expect(await pushes(harness.log)).toHaveLength(1);
    },
  );

  it.each([
    ["label loss", { labels: [] }],
    ["body loss", { body: "human edit" }],
    ["state loss", { state: "closed" }],
    ["base loss", { base: { ref: "other" } }],
    [
      "head loss",
      { head: { ref: "other", repo: { full_name: "owner/repo" }, sha: "OLD" } },
    ],
  ])(
    "does not push or patch after pre-push %s",
    async (_name, changed) => {
      const harness = await makeHarness({ existing: true });
      harness.get.mockResolvedValueOnce({
        data: mergePull(harness.pull, changed),
        headers: { etag: '"before"' },
      });

      await expect(runUpdate(harness.execution)).rejects.toThrow(
        /changed after initial observation/u,
      );
      expect(await pushes(harness.log)).toEqual([]);
      expect(harness.update).not.toHaveBeenCalled();
    },
    15_000,
  );

  it("does not push or patch when the observed branch ref disappears before push", async () => {
    const harness = await makeHarness({ existing: true, refLossAt: 2 });

    await expect(runUpdate(harness.execution)).rejects.toThrow(/missing/u);
    expect(await pushes(harness.log)).toEqual([]);
    expect(harness.update).not.toHaveBeenCalled();
  });

  it("rolls post-push proof loss back to the exact observed SHA without patching", async () => {
    const harness = await makeHarness({ existing: true, loseAfterPush: true });

    await expect(runUpdate(harness.execution)).rejects.toThrow(
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
    expect(harness.update).not.toHaveBeenCalled();
  });

  it("reports partial state when the post-push rollback lease fails", async () => {
    const harness = await makeHarness({ existing: true, loseAfterPush: true });
    process.env.TEST_GIT_FAIL_PUSH = "2";

    await expect(runUpdate(harness.execution)).rejects.toThrow(
      /rollback also failed.*preserved/u,
    );
    expect(await pushes(harness.log)).toHaveLength(2);
    expect(harness.update).not.toHaveBeenCalled();
  });

  it("rolls an existing branch back when pull metadata update fails", async () => {
    const harness = await makeHarness({ existing: true });
    harness.pull.title = "Previous update";
    harness.update.mockRejectedValueOnce(new Error("timeout"));
    harness.get.mockImplementation(async () => {
      const sha = await remoteSha(harness.remote);
      return {
        data: mergePull(harness.pull, {
          head: { ...harness.pull.head, sha },
        }),
        headers: { etag: '"after"' },
      };
    });

    await expect(runUpdate(harness.execution)).rejects.toThrow(
      /lease-rolled back/u,
    );
    expect(await remoteSha(harness.remote)).toBe(harness.oldSha);
  });

  it("preserves the new branch when an applied metadata update cannot be verified", async () => {
    const harness = await makeHarness({ existing: true });
    let metadataUpdateAttempted = false;
    harness.get.mockImplementation(async () => {
      const sha = await remoteSha(harness.remote);
      if (metadataUpdateAttempted && sha !== harness.oldSha) {
        throw new Error("verification timeout");
      }
      return {
        data: mergePull(harness.pull, {
          head: { ...harness.pull.head, sha },
        }),
        headers: { etag: '"after"' },
      };
    });
    harness.update.mockImplementationOnce(async () => {
      metadataUpdateAttempted = true;
      return {
        data: mergePull(harness.pull, { body: "unexpected response" }),
        headers: { etag: '"unexpected"' },
      };
    });

    await expect(runUpdate(harness.execution)).rejects.toThrow(
      /metadata outcome is ambiguous.*new branch was preserved/u,
    );
    expect(await remoteSha(harness.remote)).not.toBe(harness.oldSha);
    expect(await pushes(harness.log)).toHaveLength(1);
  });

  it("normalizes CRLF only when verifying unchanged original metadata", async () => {
    const harness = await makeHarness({ existing: true });
    harness.pull.body = `${BODY_MARKER}\r\noriginal`;
    harness.update.mockRejectedValueOnce(new Error("timeout"));
    harness.get.mockImplementation(async () => ({
      data: mergePull(harness.pull, {
        body: `${BODY_MARKER}\noriginal`,
        head: {
          ...harness.pull.head,
          sha: await remoteSha(harness.remote),
        },
      }),
      headers: { etag: '"after"' },
    }));

    await expect(runUpdate(harness.execution)).rejects.toThrow(
      /lease-rolled back/u,
    );
    expect(await remoteSha(harness.remote)).toBe(harness.oldSha);
  });

  it("normalizes CRLF when verifying freshly updated metadata", async () => {
    const harness = await makeHarness({ existing: true });
    await writeFile(
      harness.prek,
      "#!/bin/sh\nprintf 'updated\\n' > prek.toml\nprintf 'detail\\n'\n",
    );
    harness.update.mockResolvedValueOnce({
      data: mergePull(harness.pull, { body: "unexpected response" }),
      headers: { etag: '"unexpected"' },
    });
    const updatedBody = `${BODY_MARKER}\r\n\r\n<details><summary>prek output</summary>\r\n\r\n\`\`\`text\r\ndetail\r\n\`\`\`\r\n</details>`;
    harness.get.mockImplementation(async () => ({
      data: mergePull(harness.pull, {
        body: updatedBody,
        head: {
          ...harness.pull.head,
          sha: await remoteSha(harness.remote),
        },
      }),
      headers: { etag: '"after"' },
    }));

    await expect(runUpdate(harness.execution)).resolves.toEqual({
      operation: "updated",
      pullRequestNumber: 42,
    });
  });

  it("reconciles a branch tied to one exact closed owned pull request", async () => {
    const harness = await makeHarness({ existing: true, closedExisting: true });
    harness.create.mockImplementation(async () => ({
      data: mergePull(harness.pull, {
        number: 77,
        state: "open",
        closed_at: null,
        head: {
          ...harness.pull.head,
          sha: await remoteSha(harness.remote),
        },
      }),
    }));
    harness.get.mockImplementation(async () => ({
      data: mergePull(harness.pull, {
        number: 77,
        state: "open",
        closed_at: null,
        head: {
          ...harness.pull.head,
          sha: await remoteSha(harness.remote),
        },
      }),
      headers: { etag: '"created"' },
    }));

    await expect(runUpdate(harness.execution)).resolves.toEqual({
      operation: "created",
      pullRequestNumber: 77,
    });
    expect(harness.create).toHaveBeenCalledTimes(1);
  });

  it("preserves the update ref when the associated pull only matches the cleanup prefix", async () => {
    const harness = await makeHarness({ existing: true });
    harness.pull.head.ref = "chore/prek-old";

    await expect(runUpdate(harness.execution)).rejects.toThrow(/not owned/u);

    expect(await remoteSha(harness.remote)).toBe(harness.oldSha);
    expect(harness.create).not.toHaveBeenCalled();
    expect(harness.update).not.toHaveBeenCalled();
  });

  it("preserves a created branch when closing after label failure fails", async () => {
    const harness = await makeHarness();
    harness.create.mockImplementation(async () => ({
      data: mergePull(harness.pull, {
        head: {
          ...harness.pull.head,
          sha: await remoteSha(harness.remote),
        },
      }),
    }));
    harness.addLabels.mockRejectedValueOnce(new Error("label failed"));
    harness.update.mockRejectedValueOnce(new Error("close failed"));

    await expect(runUpdate(harness.execution)).rejects.toThrow(
      /closing it also failed.*branch was preserved/u,
    );
    expect(await pushes(harness.log)).toHaveLength(1);
  });

  it("closes a created pull before lease-deleting after label failure", async () => {
    const harness = await makeHarness();
    harness.create.mockImplementation(async () => ({
      data: mergePull(harness.pull, {
        head: {
          ...harness.pull.head,
          sha: await remoteSha(harness.remote),
        },
      }),
    }));
    harness.addLabels.mockRejectedValueOnce(new Error("label failed"));

    await expect(runUpdate(harness.execution)).rejects.toThrow(
      /closed and its branch was lease-rolled back/u,
    );
    expect(harness.update).toHaveBeenCalledWith(
      expect.objectContaining({ pull_number: 42, state: "closed" }),
    );
    expect(await pushes(harness.log)).toHaveLength(2);
  });

  it("accepts an unexpected update response only after an exact fresh GET", async () => {
    const harness = await makeHarness({ existing: true });
    const unexpectedResponse = {
      data: mergePull(harness.pull, { body: "unexpected response" }),
      headers: { etag: '"unexpected"' },
    };
    const pendingUpdate = Promise.withResolvers<typeof unexpectedResponse>();
    let getCallsWhenUpdateStarted = 0;
    harness.update.mockImplementationOnce(() => {
      getCallsWhenUpdateStarted = harness.get.mock.calls.length;
      return pendingUpdate.promise;
    });

    const result = runUpdate(harness.execution);
    await vi.waitFor(() => expect(harness.update).toHaveBeenCalledOnce());
    expect(harness.get).toHaveBeenCalledTimes(getCallsWhenUpdateStarted);

    pendingUpdate.resolve(unexpectedResponse);
    await expect(result).resolves.toEqual({
      operation: "updated",
      pullRequestNumber: 42,
    });
    expect(harness.get.mock.calls.length).toBeGreaterThan(
      getCallsWhenUpdateStarted,
    );
    expect(await pushes(harness.log)).toHaveLength(1);
  });

  it("does not close or delete an existing pull when cached diff errors", async () => {
    const harness = await makeHarness({ existing: true, noChange: true });
    process.env.TEST_GIT_FAIL_DIFF = "1";

    await expect(runUpdate(harness.execution)).rejects.toThrow(
      /diff --cached --quiet failed/u,
    );
    expect(harness.update).not.toHaveBeenCalled();
    expect(await pushes(harness.log)).toEqual([]);
  });

  it("does not persist the bot commit identity in repository config", async () => {
    const harness = await makeHarness({ existing: true });
    await runUpdate(harness.execution);

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
    ["before the run", 1],
    ["during the run", 2],
  ])(
    "prevents mutation when the base ref drifts %s",
    async (_name, driftAt) => {
      const harness = await makeHarness({ baseDriftAt: driftAt });

      await expect(runUpdate(harness.execution)).rejects.toThrow(
        /base branch changed/u,
      );
      expect(await pushes(harness.log)).toEqual([]);
      expect(harness.create).not.toHaveBeenCalled();
    },
  );
});

describe("detached caller checkout", () => {
  it("refuses a stale detached checkout with an actionable message and no mutation", async () => {
    const harness = await makeHarness({ detached: true, baseDriftAt: 1 });
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

    const error = await runUpdate(harness.execution).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toMatch(/base branch changed after checkout/u);
    expect(message).toContain("DRIFT");
    expect(message).toContain(harness.execution.context.baseSha);
    expect(await pushes(harness.log)).toEqual([]);
    expect(harness.create).not.toHaveBeenCalled();
  });

  it("proceeds from a detached checkout at the branch tip", async () => {
    const harness = await makeHarness({
      detached: true,
      existing: true,
      noChange: true,
    });
    await expect(runUpdate(harness.execution)).resolves.toMatchObject({
      operation: "closed",
    });
  });
});

describe("no-change close compensation", () => {
  it("returns the closed pull and deleted branch for reporting", async () => {
    const harness = await makeHarness({ existing: true, noChange: true });
    await expect(runUpdate(harness.execution)).resolves.toEqual({
      operation: "closed",
      cleanup: {
        closedPullRequests: [42],
        deletedBranches: ["chore/prek-updates"],
      },
    });
  });

  it("preserves the branch and refuses reopen when close response loses identity", async () => {
    const harness = await makeHarness({ existing: true, noChange: true });
    harness.update.mockResolvedValueOnce({
      data: mergePull(harness.pull, {
        state: "closed",
        body: "changed",
        closed_at: "2026-07-28T00:00:01Z",
      }),
      headers: { etag: '"close"' },
    });

    await expect(runUpdate(harness.execution)).rejects.toThrow(
      /unexpected pull request after close/u,
    );
    expect(await pushes(harness.log)).toEqual([]);
    expect(harness.update).toHaveBeenCalledTimes(1);
  });

  it("reopens only the exact unchanged close event with its ETag after delete failure", async () => {
    const harness = await makeHarness({ existing: true, noChange: true });
    process.env.TEST_GIT_FAIL_PUSH = "1";

    await expect(runUpdate(harness.execution)).rejects.toThrow(
      /was compensated/u,
    );
    expect(harness.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        state: "open",
        headers: { "If-Match": '"close"' },
      }),
    );
  });

  it.each([
    ["changed timestamp", { updated_at: "2026-07-28T00:00:02Z" }],
    ["changed closed_at", { closed_at: "2026-07-28T00:00:02Z" }],
    ["changed ownership", { labels: [] }],
  ])("never reopens after %s", async (_name, changed) => {
    const harness = await makeHarness({ existing: true, noChange: true });
    process.env.TEST_GIT_FAIL_PUSH = "1";
    harness.get
      .mockResolvedValueOnce({
        data: harness.pull,
        headers: { etag: '"before"' },
      })
      .mockResolvedValueOnce({
        data: mergePull(harness.pull, {
          state: "closed",
          closed_at: "2026-07-28T00:00:01Z",
          ...changed,
        }),
        headers: { etag: '"close"' },
      });

    await expect(runUpdate(harness.execution)).rejects.toThrow(
      /was not reopened/u,
    );
    expect(harness.update).toHaveBeenCalledTimes(1);
  });
});

it("preserves a cleanup ref and discards credentials from a rejected push error", async () => {
  const harness = await makeHarness({ existing: true, closedExisting: true });
  const token = "fake-cleanup-credential";
  const execution = {
    ...harness.execution,
    inputs: { ...harness.execution.inputs, token },
  };
  Object.assign(execution.client.paginate, {
    async *iterator(_endpoint: unknown, { state }: { state: string }) {
      yield { data: state === "closed" ? [harness.pull] : [] };
    },
  });
  process.env.TEST_GIT_FAIL_PUSH = "1";
  process.env.TEST_GIT_FAILURE_OUTPUT = token;

  const error = await cleanupUpdateBranches(execution, {
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
  baseDriftAt?: number;
  detached?: boolean;
  refLossAt?: number;
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
  const create = vi.fn();
  let closedPull: ReturnType<typeof ownedPull> | undefined;
  const update = vi.fn(
    async ({
      state,
      body,
      title,
    }: {
      state?: string;
      body?: string;
      title?: string;
    }) => {
      const data = mergePull(pull, {
        state: state ?? pull.state,
        body: body ?? pull.body,
        title: title ?? pull.title,
        head: {
          ...pull.head,
          sha: await remoteSha(remote),
        },
        updated_at:
          state === "closed" ? "2026-07-28T00:00:01Z" : pull.updated_at,
        closed_at: state === "closed" ? "2026-07-28T00:00:01Z" : pull.closed_at,
      });
      if (state === "closed") closedPull = data;
      return { data, headers: { etag: '"close"' } };
    },
  );
  let getCalls = 0;
  const get = vi.fn(async () => {
    getCalls += 1;
    const currentSha = await remoteSha(remote);
    const data =
      closedPull ??
      (options.loseAfterPush && getCalls > 1
        ? mergePull(pull, {
            labels: [],
            head: { ...pull.head, sha: currentSha },
          })
        : mergePull(pull, { head: { ...pull.head, sha: currentSha } }));
    return { data, headers: { etag: '"close"' } };
  });
  let baseChecks = 0;
  let updateRefChecks = 0;
  const getRef = vi.fn(async ({ ref }: { ref: string }) => {
    if (ref === "heads/main") {
      baseChecks += 1;
      return {
        data: {
          object: {
            sha:
              baseChecks >= (options.baseDriftAt ?? Infinity)
                ? "DRIFT"
                : baseSha,
          },
        },
      };
    }
    updateRefChecks += 1;
    const { stdout } = await exec("git", [
      "ls-remote",
      "--refs",
      remote,
      `refs/${ref}`,
    ]);
    const sha = stdout.split("\t")[0];
    if (!sha || updateRefChecks >= (options.refLossAt ?? Infinity)) {
      throw Object.assign(new Error("missing"), { status: 404 });
    }
    return { data: { object: { sha } } };
  });
  const paginate = vi.fn(async () => (options.existing ? [pull] : []));
  const addLabels = vi.fn();
  const getLabel = vi.fn(async () => ({ data: { name: "dependencies" } }));
  const graphql = vi.fn();
  const client = {
    graphql,
    paginate,
    rest: {
      git: { getRef },
      issues: { addLabels, getLabel },
      pulls: { create, get, list: vi.fn(), update },
    },
  } as unknown as GitHubClient;
  const execution = {
    client,
    context: {
      authenticatedLogin: "github-actions[bot]",
      tokenAuthenticatedAsUser: true,
      baseBranch: "main",
      baseSha,
      eventName: "schedule",
      owner: "owner",
      repository: "repo",
      repositoryFullName: "owner/repo",
      serverUrl: "https://github.com",
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
      token: "token",
      updateBranch: "chore/prek-updates",
      updateDay: 1,
    },
  } satisfies ActionExecution;
  process.env.TEST_GIT_URL = `${execution.context.serverUrl}/${execution.context.repositoryFullName}.git`;
  return {
    addLabels,
    create,
    execution,
    get,
    graphql,
    log,
    oldSha,
    paginate,
    prek,
    pull,
    remote,
    update,
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
  *" worktree list "*)
    [ "$TEST_GIT_FAIL_WORKTREE_LIST" = "1" ] && exit 1
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

function mergePull(
  pull: ReturnType<typeof ownedPull>,
  changed: Record<string, unknown>,
): ReturnType<typeof ownedPull> {
  return { ...pull, ...changed } as ReturnType<typeof ownedPull>;
}

function autoMergePull(headRefOid: string, enabled = false) {
  return {
    autoMergeRequest: enabled
      ? {
          enabledAt: "2026-08-23T12:00:00Z",
          mergeMethod: "SQUASH",
        }
      : null,
    author: { login: "github-actions[bot]" },
    baseRefName: "main",
    body: BODY_MARKER,
    headRefOid,
    headRefName: "chore/prek-updates",
    headRepository: { nameWithOwner: "owner/repo" },
    id: "PR_node",
    labels: {
      nodes: [{ name: "dependencies" }],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
    number: 42,
    state: "OPEN",
  };
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

import { execFile } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import type * as EnvironmentModule from "../../src/environment.js";

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

import type { ActionExecution, GitHubClient } from "../../src/contracts.js";
import { BODY_MARKER, runUpdate } from "../../src/update/index.js";

const exec = promisify(execFile);
const cleanups: string[] = [];
const originalPath = process.env.PATH;

afterEach(async () => {
  process.env.PATH = originalPath;
  delete process.env.TEST_GIT_LOG;
  delete process.env.TEST_GIT_REMOTE;
  delete process.env.TEST_GIT_URL;
  delete process.env.TEST_GIT_FAIL_PUSH;
  delete process.env.TEST_GIT_FAIL_DIFF;
  delete process.env.TEST_GIT_FAIL_WORKTREE_REMOVE;
  delete process.env.TEST_GIT_FAIL_WORKTREE_ADD_AFTER;
  delete process.env.TEST_GIT_FAIL_WORKTREE_ADD_BEFORE;
  delete process.env.TEST_GIT_WORKTREE_ADD_LOG;
  delete process.env.TEST_GIT_WORKTREE_REMOVE_LOG;
  installPrek.mockReset();
  await Promise.all(
    cleanups
      .splice(0)
      .map((entry) => rm(entry, { recursive: true, force: true })),
  );
});

describe("update publication races", () => {
  it("cleans an ordinary pre-registration worktree add failure", async () => {
    const harness = await makeHarness({ noChange: true });
    const initial = await worktrees(harness.execution.context.workspace);
    process.env.TEST_GIT_FAIL_WORKTREE_ADD_BEFORE = "1";
    process.env.TEST_GIT_WORKTREE_ADD_LOG = `${harness.log}.worktree-add`;

    const error = await runUpdate(harness.execution).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AggregateError);
    expect(await worktrees(harness.execution.context.workspace)).toEqual(
      initial,
    );
    const addArguments = await readFile(
      process.env.TEST_GIT_WORKTREE_ADD_LOG,
      "utf8",
    );
    const addParts = addArguments.trim().split(" ");
    const worktreePath = addParts[addParts.indexOf("--detach") + 1]!;
    await expect(access(path.dirname(worktreePath))).rejects.toThrow();
  });

  it("cleans a partially successful worktree add", async () => {
    const harness = await makeHarness({ noChange: true });
    const initial = await worktrees(harness.execution.context.workspace);
    process.env.TEST_GIT_FAIL_WORKTREE_ADD_AFTER = "1";

    await expect(runUpdate(harness.execution)).rejects.toThrow();

    expect(await worktrees(harness.execution.context.workspace)).toEqual(
      initial,
    );
  });

  it("retries worktree removal once and restores the initial worktree list", async () => {
    const harness = await makeHarness({ noChange: true });
    const initial = await worktrees(harness.execution.context.workspace);
    process.env.TEST_GIT_FAIL_WORKTREE_REMOVE = "1";
    process.env.TEST_GIT_WORKTREE_REMOVE_LOG = `${harness.log}.worktree`;

    await expect(runUpdate(harness.execution)).resolves.toEqual({
      operation: "none",
    });

    expect(await worktrees(harness.execution.context.workspace)).toEqual(
      initial,
    );
    const removals = (
      await readFile(process.env.TEST_GIT_WORKTREE_REMOVE_LOG!, "utf8")
    )
      .trim()
      .split("\n");
    expect(removals[0]).toContain("worktree remove --force");
    expect(removals[1]).toContain("worktree remove --force --force");
  });

  it("aggregates persistent worktree removal failure", async () => {
    const harness = await makeHarness({ noChange: true });
    const initial = await worktrees(harness.execution.context.workspace);
    process.env.TEST_GIT_FAIL_WORKTREE_REMOVE = "always";
    process.env.TEST_GIT_WORKTREE_REMOVE_LOG = `${harness.log}.worktree`;

    const error = await runUpdate(harness.execution).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({
      message: "Update operation completed but cleanup failed",
    });
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({
        message: expect.stringMatching(/preserved for inspection/u),
      }),
    ]);
    const final = await worktrees(harness.execution.context.workspace);
    expect(final).toHaveLength(initial.length + 1);
    const preserved = final.find((entry) => !initial.includes(entry))!;
    const preservedPath = preserved.replace(/^worktree /u, "");
    await expect(access(preservedPath)).resolves.toBeUndefined();

    delete process.env.TEST_GIT_FAIL_WORKTREE_REMOVE;
    await exec("git", [
      "-C",
      harness.execution.context.workspace,
      "worktree",
      "remove",
      "--force",
      "--force",
      preservedPath,
    ]);
    await rm(path.dirname(preservedPath), { force: true, recursive: true });
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

describe("no-change close compensation", () => {
  it("returns a closed result without leaking the pull request number", async () => {
    const harness = await makeHarness({ existing: true, noChange: true });
    await expect(runUpdate(harness.execution)).resolves.toEqual({
      operation: "closed",
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

interface HarnessOptions {
  existing?: boolean;
  closedExisting?: boolean;
  noChange?: boolean;
  loseAfterPush?: boolean;
  baseDriftAt?: number;
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
    if (!options.existing) {
      throw Object.assign(new Error("missing"), { status: 404 });
    }
    updateRefChecks += 1;
    if (updateRefChecks >= (options.refLossAt ?? Infinity)) {
      throw Object.assign(new Error("missing"), { status: 404 });
    }
    return { data: { object: { sha: await remoteSha(remote) } } };
  });
  const paginate = vi.fn(async () => (options.existing ? [pull] : []));
  const addLabels = vi.fn();
  const getLabel = vi.fn(async () => ({ data: { name: "dependencies" } }));
  const client = {
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
    log,
    oldSha,
    paginate,
    prek,
    pull,
    remote,
    update,
  };
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
    [ -n "$TEST_GIT_WORKTREE_ADD_LOG" ] && printf '%s\n' "$*" >> "$TEST_GIT_WORKTREE_ADD_LOG"
    [ "$TEST_GIT_FAIL_WORKTREE_ADD_BEFORE" = "1" ] && exit 1
    if [ "$TEST_GIT_FAIL_WORKTREE_ADD_AFTER" = "1" ]; then
      eval ${JSON.stringify(realGit)} "$args" || exit $?
      exit 1
    fi
    ;;
  *" worktree remove --force "*)
    if [ -n "$TEST_GIT_FAIL_WORKTREE_REMOVE" ]; then
      printf '%s\n' "$*" >> "$TEST_GIT_WORKTREE_REMOVE_LOG"
      count=$(wc -l < "$TEST_GIT_WORKTREE_REMOVE_LOG" | tr -d ' ')
      { [ "$TEST_GIT_FAIL_WORKTREE_REMOVE" = "always" ] || [ "$count" = "$TEST_GIT_FAIL_WORKTREE_REMOVE" ]; } && exit 1
    fi
    ;;
  *" diff --cached --quiet "*)
    [ "$TEST_GIT_FAIL_DIFF" = "1" ] && exit 2
    ;;
  *" push "*)
    printf '%s\\n' "$*" >> "$TEST_GIT_LOG"
    count=$(wc -l < "$TEST_GIT_LOG" | tr -d ' ')
    [ "$count" = "$TEST_GIT_FAIL_PUSH" ] && exit 1
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
  ]);
  return result.stdout.match(/^worktree .+$/gmu) ?? [];
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

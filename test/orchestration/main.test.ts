import * as core from "@actions/core";
import * as github from "@actions/github";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  cleanupUpdateBranches,
  cleanupWithApi,
} from "../../src/cleanup/index.js";
import {
  CreatedPullOwnershipError,
  PublishedPullRequestError,
  PublishedUpdateError,
  type ActionContext,
  type ActionInputs,
} from "../../src/contracts.js";
import {
  parseInputs,
  resolveContext,
  validateCheckout,
} from "../../src/input.js";
import { runAction } from "../../src/main.js";
import { BODY_MARKER } from "../../src/ownership.js";
import {
  runUpdate,
  validateCleanupConfiguration,
  validateUpdateConfiguration,
} from "../../src/update/index.js";
import { InMemoryGitHub } from "../support/in-memory-github.js";

vi.mock("@actions/core", () => ({
  error: vi.fn(),
  getInput: vi.fn(),
  info: vi.fn(),
  setFailed: vi.fn(),
  setOutput: vi.fn(),
}));
vi.mock("@actions/github", () => ({ getOctokit: vi.fn() }));
vi.mock("../../src/input.js", () => ({
  parseInputs: vi.fn(),
  resolveContext: vi.fn(),
  shouldUpdate: vi.fn((eventName: string) => eventName !== "push"),
  validateCheckout: vi.fn(),
}));
vi.mock("../../src/update/index.js", () => ({
  runUpdate: vi.fn(),
  validateCleanupConfiguration: vi.fn(),
  validateUpdateConfiguration: vi.fn(),
}));
vi.mock(import("../../src/cleanup/index.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  cleanupUpdateBranches: vi.fn(),
}));
vi.mock("../../src/version.js", () => ({
  versionBanner: vi.fn(() => "prek-autoupdate version sentinel"),
}));

const inputs: ActionInputs = {
  token: "token",
  autoMerge: false,
  authorLogin: "github-actions[bot]",
  cooldownDays: "7",
  updateDay: 1,
  updateBranch: "chore/prek-updates",
  branchPrefix: "chore/prek-updates",
  label: "dependencies",
  commitMessage: "message",
  prTitle: "title",
  addPaths: [],
};
const context: ActionContext = {
  eventName: "schedule",
  owner: "owner",
  repository: "repo",
  repositoryFullName: "owner/repo",
  serverUrl: "https://github.com",
  workspace: "/workspace",
  baseBranch: "main",
  baseSha: "base",
  authenticatedLogin: "github-actions[bot]",
  tokenAuthenticatedAsUser: false,
};

function reconcileOwnedPulls(older: number): InMemoryGitHub {
  const adapter = new InMemoryGitHub(
    [inputs.updateBranch, `${inputs.updateBranch}-latest`].map(
      (branch, index) => ({
        number: older + index,
        state: "open",
        body: BODY_MARKER,
        labels: [{ name: inputs.label }],
        user: { login: context.authenticatedLogin },
        head: {
          ref: branch,
          sha: `head-${index}`,
          repo: { full_name: context.repositoryFullName },
        },
        base: { ref: context.baseBranch },
        changed_files: 1,
      }),
    ),
  );
  adapter.refs.set(`heads/${inputs.updateBranch}`, "head-0");
  adapter.refs.set(`heads/${inputs.updateBranch}-latest`, "head-1");
  vi.mocked(cleanupUpdateBranches).mockImplementationOnce((execution, update) =>
    cleanupWithApi(adapter, execution, update),
  );
  return adapter;
}

describe("runAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(parseInputs).mockReturnValue(inputs);
    vi.mocked(github.getOctokit).mockReturnValue(
      {} as ReturnType<typeof github.getOctokit>,
    );
    vi.mocked(resolveContext).mockResolvedValue(context);
    vi.mocked(validateCheckout).mockResolvedValue();
    vi.mocked(validateCleanupConfiguration).mockReturnValue();
    vi.mocked(validateUpdateConfiguration).mockResolvedValue();
    vi.mocked(runUpdate).mockResolvedValue({
      operation: "created",
      pullRequestNumber: 42,
    });
    vi.mocked(cleanupUpdateBranches).mockResolvedValue({
      closedPullRequests: [],
      deletedBranches: [],
    });
  });

  it("logs the prek-autoupdate release version", async () => {
    await runAction(new Date("2026-07-27T02:00:00Z"));

    expect(core.info).toHaveBeenCalledWith("prek-autoupdate version sentinel");
    expect(core.info).toHaveBeenCalledBefore(vi.mocked(parseInputs));
  });

  it("reports a confirmed publication on a scheduled run", async () => {
    await runAction(new Date("2026-07-27T02:00:00Z"));

    expect(core.setOutput).toHaveBeenCalledWith("pull-request-number", "42");
  });

  it("preserves an unverified creation, reports failure, and leaves the output empty", async () => {
    const adapter = reconcileOwnedPulls(42);
    const ownershipError = new CreatedPullOwnershipError(
      42,
      new Error("PR changed"),
    );
    vi.mocked(runUpdate).mockRejectedValue(
      new AggregateError(
        [ownershipError, new Error("Worktree cleanup failed")],
        "Update and cleanup failed",
        { cause: ownershipError },
      ),
    );

    await runAction();

    expect(adapter.pulls.get(42)?.state).toBe("open");
    expect(adapter.refs.get(`heads/${inputs.updateBranch}`)).toBe("head-0");
    expect(adapter.pulls.get(43)?.state).toBe("open");
    expect(core.setOutput).toHaveBeenCalledWith("pull-request-number", "");
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining(
        "Could not verify ownership of created pull request #42",
      ),
    );
  });

  it("runs push reconciliation without updating", async () => {
    vi.mocked(resolveContext).mockResolvedValue({
      ...context,
      eventName: "push",
    });

    await runAction();

    expect(runUpdate).not.toHaveBeenCalled();
    expect(cleanupUpdateBranches).toHaveBeenCalledOnce();
    expect(core.setOutput).toHaveBeenCalledWith("pull-request-number", "");
  });

  it("reports pull and branch cleanup performed by the update phase", async () => {
    vi.mocked(runUpdate).mockResolvedValue({
      operation: "closed",
      cleanup: {
        closedPullRequests: [41],
        deletedBranches: ["chore/prek-updates"],
      },
    });

    await runAction();

    expect(core.setOutput).toHaveBeenCalledWith("pull-request-number", "");
    expect(core.info).toHaveBeenCalledWith("Closed PRs: 41");
    expect(core.info).toHaveBeenCalledWith(
      "Deleted branches: chore/prek-updates",
    );
  });

  it("runs cleanup and reports both phase failures", async () => {
    vi.mocked(runUpdate).mockRejectedValue(new Error("update failed"));
    vi.mocked(cleanupUpdateBranches).mockRejectedValue(
      new Error("cleanup failed"),
    );

    await runAction();

    expect(cleanupUpdateBranches).toHaveBeenCalledOnce();
    expect(core.setFailed).toHaveBeenCalledWith(
      "update: update failed; cleanup: cleanup failed",
    );
  });

  it("preserves and reports the published pull when a post-publication step fails", async () => {
    const adapter = reconcileOwnedPulls(41);
    vi.mocked(runUpdate).mockRejectedValue(
      new PublishedPullRequestError(
        "created",
        41,
        new Error("auto-merge failed"),
      ),
    );

    await runAction();

    expect(adapter.pulls.get(41)?.state).toBe("open");
    expect(adapter.refs.get(`heads/${inputs.updateBranch}`)).toBe("head-0");
    expect(adapter.pulls.get(42)?.state).toBe("closed");
    expect(core.setOutput).toHaveBeenCalledWith("pull-request-number", "41");
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining("Pull request #41"),
    );
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining("auto-merge failed"),
    );
  });

  it("keeps the exact published result through an update and cleanup failure", async () => {
    const result = { operation: "updated" as const, pullRequestNumber: 41 };
    vi.mocked(runUpdate).mockRejectedValue(
      new PublishedUpdateError(
        result,
        new AggregateError(
          [
            new Error("auto-merge failed"),
            new Error("worktree cleanup failed"),
          ],
          "Update failed and cleanup also failed",
        ),
      ),
    );
    vi.mocked(cleanupUpdateBranches).mockRejectedValue(
      new Error("action cleanup failed"),
    );

    await runAction();

    expect(core.setOutput).toHaveBeenCalledWith("pull-request-number", "41");
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining("auto-merge failed"),
    );
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining("action cleanup failed"),
    );
  });

  it("still runs cleanup when update configuration validation fails", async () => {
    vi.mocked(validateUpdateConfiguration).mockRejectedValue(
      new Error("invalid config"),
    );

    await runAction();
    expect(runUpdate).not.toHaveBeenCalled();
    expect(cleanupUpdateBranches).toHaveBeenCalledOnce();
    expect(core.setFailed).toHaveBeenCalledWith("update: invalid config");
  });

  it("does not run cleanup with an invalid ownership namespace", async () => {
    vi.mocked(validateCleanupConfiguration).mockImplementation(() => {
      throw new Error("invalid ownership namespace");
    });

    await expect(runAction()).rejects.toThrow("invalid ownership namespace");
    expect(validateCheckout).not.toHaveBeenCalled();
    expect(runUpdate).not.toHaveBeenCalled();
    expect(cleanupUpdateBranches).not.toHaveBeenCalled();
  });
});

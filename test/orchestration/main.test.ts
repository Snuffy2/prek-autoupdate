import * as core from "@actions/core";
import * as github from "@actions/github";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupUpdateBranches } from "../../src/cleanup/index.js";
import type { ActionContext, ActionInputs } from "../../src/contracts.js";
import {
  parseInputs,
  resolveContext,
  validateCheckout,
} from "../../src/input.js";
import { runAction } from "../../src/main.js";
import {
  runUpdate,
  validateCleanupConfiguration,
  validateUpdateConfiguration,
} from "../../src/update/index.js";

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
vi.mock("../../src/cleanup/index.js", () => ({
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

  it("keeps the updated pull request during scheduled cleanup", async () => {
    await runAction(new Date("2026-07-27T02:00:00Z"));

    expect(cleanupUpdateBranches).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        keepPullRequestNumber: 42,
        keepLatestOpenPullRequest: false,
        closeStalePullRequests: true,
        closeObsoletePullRequests: false,
      }),
    );
    expect(core.setOutput).toHaveBeenCalledWith("pull-request-number", "42");
  });

  it("runs push reconciliation without updating", async () => {
    vi.mocked(resolveContext).mockResolvedValue({
      ...context,
      eventName: "push",
    });

    await runAction();

    expect(runUpdate).not.toHaveBeenCalled();
    expect(cleanupUpdateBranches).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        keepLatestOpenPullRequest: true,
        closeStalePullRequests: false,
        closeObsoletePullRequests: true,
      }),
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

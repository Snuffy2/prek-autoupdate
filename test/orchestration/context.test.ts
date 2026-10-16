import * as github from "@actions/github";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionInputs, GitHubClient } from "../../src/contracts.js";
import { resolveContext } from "../../src/input.js";

vi.mock("@actions/github", () => ({
  context: {
    eventName: "schedule",
    ref: "refs/heads/main",
    repo: { owner: "example", repo: "project" },
    serverUrl: "https://github.com",
  },
}));

const execFileAsync = promisify(execFile);
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const inputs = { token: "token", authorLogin: "bot" } as ActionInputs;
const client = {
  rest: {
    users: {
      getAuthenticated: vi.fn(async () => ({ data: { login: "bot" } })),
    },
  },
} as unknown as GitHubClient;

async function git(directory: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", directory, ...args]);
  return stdout.trim();
}

describe("resolveContext checkout branches", () => {
  let directory: string;
  let originalSha: string;

  beforeEach(async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    directory = await mkdtemp(path.join(tmpdir(), "prek-context-test-"));
    vi.stubEnv("GITHUB_WORKSPACE", directory);
    github.context.eventName = "schedule";
    github.context.ref = "refs/heads/main";
    await git(directory, "init", "--initial-branch=main");
    await git(
      directory,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    );
    originalSha = await git(directory, "rev-parse", "HEAD");
  });

  afterEach(async () => {
    Object.defineProperty(process, "platform", platform);
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it.each(["push", "schedule", "workflow_dispatch"])(
    "resolves a detached %s checkout without advancing its commit",
    async (eventName) => {
      github.context.eventName = eventName;
      github.context.ref = "refs/heads/release/next";
      await git(directory, "branch", "release/next");
      await git(
        directory,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "-m",
        "newer tip",
      );
      await git(directory, "branch", "--force", "release/next", "HEAD");
      await git(directory, "checkout", "--detach", originalSha);

      await expect(resolveContext(client, inputs)).resolves.toMatchObject({
        baseBranch: "release/next",
        baseSha: originalSha,
        eventName,
      });
      expect(await git(directory, "rev-parse", "HEAD")).toBe(originalSha);
      expect(await git(directory, "branch", "--show-current")).toBe("");
      expect(await git(directory, "rev-parse", "release/next")).not.toBe(
        originalSha,
      );
    },
  );

  it("preserves the attached checkout branch even when the event ref differs", async () => {
    github.context.ref = "refs/heads/another-branch";
    await expect(resolveContext(client, inputs)).resolves.toMatchObject({
      baseBranch: "main",
      baseSha: originalSha,
    });
  });

  it.each([
    "refs/tags/v1",
    "",
    "refs/pull/1/merge",
    "refs/heads/",
    "refs/heads/bad..name",
    "refs/heads/double//slash",
    "refs/heads/@{-1}",
  ])("rejects detached checkout with workflow ref %j", async (ref) => {
    github.context.ref = ref;
    await git(directory, "checkout", "--detach", originalSha);
    await expect(resolveContext(client, inputs)).rejects.toThrow(
      "A detached checkout requires a valid workflow branch ref",
    );
  });

  it("propagates Git failures rather than treating them as detached HEAD", async () => {
    vi.stubEnv("GITHUB_WORKSPACE", path.join(directory, "missing"));
    await expect(resolveContext(client, inputs)).rejects.toThrow();
  });
});

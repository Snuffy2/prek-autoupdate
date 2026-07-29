import * as core from "@actions/core";
import * as github from "@actions/github";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  ActionContext,
  ActionInputs,
  GitHubClient,
  SupportedEventName,
} from "./contracts.js";
import {
  hardenedGitArguments,
  sanitizedChildEnvironment,
} from "./environment.js";

const SUPPORTED_EVENTS = new Set<SupportedEventName>([
  "push",
  "schedule",
  "workflow_dispatch",
]);
const execFileAsync = promisify(execFile);

export function parseInputs(): ActionInputs {
  const token = core.getInput("token", { required: true });
  core.setSecret(token);
  delete process.env.INPUT_TOKEN;

  const updateDayText = core.getInput("update-day", { required: true });
  const updateDay = Number(updateDayText);
  if (
    updateDayText.trim() === "" ||
    !Number.isInteger(updateDay) ||
    updateDay < 0 ||
    updateDay > 6
  ) {
    throw new Error("update-day must be an integer from 0 through 6");
  }
  const cooldownDays = core.getInput("cooldown-days", { required: true });

  return {
    token,
    authorLogin: nonEmptyInput("author-login"),
    cooldownDays,
    updateDay,
    updateBranch: nonEmptyInput("update-branch"),
    branchPrefix: nonEmptyInput("branch-prefix"),
    label: nonEmptyInput("label"),
    commitMessage: nonEmptyInput("commit-message"),
    prTitle: nonEmptyInput("pr-title"),
    addPaths: core
      .getInput("add-paths")
      .split(/\r?\n/u)
      .map((path) => path.trim())
      .filter((path) => path !== ""),
  };
}

export function shouldUpdate(
  eventName: SupportedEventName,
  updateDay: number,
  now: Date,
): boolean {
  if (eventName === "workflow_dispatch") {
    return true;
  }
  return eventName === "schedule" && now.getUTCDay() === updateDay;
}

export async function resolveContext(
  client: GitHubClient,
  inputs: ActionInputs,
): Promise<ActionContext> {
  assertRuntime();
  const eventName = supportedEvent(github.context.eventName);
  const workspace = process.env.GITHUB_WORKSPACE;
  if (workspace === undefined || workspace === "") {
    throw new Error("GITHUB_WORKSPACE is required");
  }

  const { owner, repo: repository } = github.context.repo;
  const repositoryFullName = `${owner}/${repository}`;
  const serverUrl = normalizeServerUrl(github.context.serverUrl);
  const baseBranch = await git(workspace, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);
  const baseSha = await git(workspace, ["rev-parse", "HEAD"]);

  return {
    eventName,
    owner,
    repository,
    repositoryFullName,
    serverUrl,
    workspace,
    baseBranch,
    baseSha,
    authenticatedLogin: await resolveAuthenticatedLogin(
      client,
      inputs.token,
      inputs.authorLogin,
    ),
  };
}

/** Validate checkout requirements needed only by the update phase. */
export async function validateCheckout(context: ActionContext): Promise<void> {
  const status = await git(context.workspace, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (status !== "") {
    throw new Error(
      "The caller checkout must be clean before running prek-autoupdate",
    );
  }
  const remoteUrl = await git(context.workspace, [
    "remote",
    "get-url",
    "origin",
  ]);
  if (
    !remoteMatchesRepository(
      remoteUrl,
      context.serverUrl,
      context.repositoryFullName,
    )
  ) {
    throw new Error(
      "The caller checkout origin does not match the workflow repository",
    );
  }
  const persistedCredential = await gitOptional(context.workspace, [
    "config",
    "--local",
    "--get-regexp",
    "^http\\..*\\.extraheader$",
  ]);
  if (persistedCredential !== "") {
    throw new Error(
      "The caller checkout must use actions/checkout with persist-credentials: false",
    );
  }
}

function nonEmptyInput(name: string): string {
  const value = core.getInput(name, { required: true });
  if (value.trim() === "") {
    throw new Error(`${name} must not be empty`);
  }
  return value;
}

function supportedEvent(eventName: string): SupportedEventName {
  if (!SUPPORTED_EVENTS.has(eventName as SupportedEventName)) {
    throw new Error(
      `Unsupported event ${JSON.stringify(eventName)}; expected push, schedule, or workflow_dispatch`,
    );
  }
  return eventName as SupportedEventName;
}

function assertRuntime(): void {
  if (process.platform !== "linux") {
    throw new Error(
      `prek-autoupdate supports Linux runners only, not ${process.platform}`,
    );
  }
  if (!["arm64", "x64"].includes(process.arch)) {
    throw new Error(
      `prek-autoupdate supports Linux x64 and arm64, not ${process.arch}`,
    );
  }
}

export async function resolveAuthenticatedLogin(
  client: GitHubClient,
  token: string,
  fallbackLogin: string,
): Promise<string> {
  core.setSecret(token);
  try {
    const response = await client.rest.users.getAuthenticated();
    return response.data.login;
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      ((error as { readonly status?: unknown }).status === 401 ||
        (error as { readonly status?: unknown }).status === 403)
    ) {
      return fallbackLogin;
    }
    throw error;
  }
}

async function git(
  workspace: string,
  arguments_: readonly string[],
): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    hardenedGitArguments(["-C", workspace, ...arguments_]),
    {
      encoding: "utf8",
      env: sanitizedChildEnvironment(),
    },
  );
  return stdout.trim();
}

async function gitOptional(
  workspace: string,
  arguments_: readonly string[],
): Promise<string> {
  try {
    return await git(workspace, arguments_);
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === 1
    ) {
      return "";
    }
    throw error;
  }
}

function remoteMatchesRepository(
  remoteUrl: string,
  serverUrl: string,
  repositoryFullName: string,
): boolean {
  const server = new URL(serverUrl);
  const expectedPath = repositoryFullName.toLowerCase();
  const scp = remoteUrl.includes("://")
    ? null
    : /^(?:[^@/:]+@)?([^/:]+):(.+)$/u.exec(remoteUrl);
  if (scp !== null) {
    return (
      scp[1]?.toLowerCase() === server.hostname.toLowerCase() &&
      normalizeRepositoryPath(scp[2] ?? "") === expectedPath
    );
  }
  try {
    const remote = new URL(remoteUrl);
    const supportedProtocol =
      remote.protocol === "https:" || remote.protocol === "ssh:";
    const originMatches =
      remote.protocol === "https:"
        ? remote.origin.toLowerCase() === server.origin.toLowerCase()
        : remote.hostname.toLowerCase() === server.hostname.toLowerCase();
    return (
      supportedProtocol &&
      originMatches &&
      normalizeRepositoryPath(remote.pathname) === expectedPath
    );
  } catch {
    return false;
  }
}

function normalizeRepositoryPath(value: string): string {
  return value
    .replace(/^\/+/u, "")
    .replace(/\.git$/u, "")
    .replace(/\/+$/u, "")
    .toLowerCase();
}

export function normalizeServerUrl(value: string): string {
  let server: URL;
  try {
    server = new URL(value);
  } catch {
    throw new Error("GITHUB_SERVER_URL must be a valid HTTPS origin");
  }
  if (
    server.protocol !== "https:" ||
    server.username !== "" ||
    server.password !== "" ||
    server.search !== "" ||
    server.hash !== "" ||
    server.hostname === "" ||
    (server.pathname !== "" && server.pathname !== "/")
  ) {
    throw new Error("GITHUB_SERVER_URL must be a valid HTTPS origin");
  }
  return server.origin;
}

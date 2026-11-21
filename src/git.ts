import * as core from "@actions/core";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { sanitizedChildEnvironment } from "./environment.js";

const execFileAsync = promisify(execFile);
const CLEANUP_TIMEOUT_MS = 30_000;

interface GitRemote {
  readonly serverUrl: string;
  readonly token: string;
  readonly repositoryFullName: string;
}

interface BranchDeletion {
  readonly remote: GitRemote;
  readonly ref: string;
  readonly expectedSha: string;
  readonly readRef: () => Promise<string | undefined>;
  readonly workspace?: string;
}

export type DeleteRefOutcome = "already-absent" | "deleted" | "lease-rejected";

async function runGit(
  arguments_: readonly string[],
  timeout?: number,
): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "credential.helper=",
      ...arguments_,
    ],
    { encoding: "utf8", env: sanitizedChildEnvironment(), timeout },
  );
  return stdout.trim();
}

export function git(
  workspace: string,
  arguments_: readonly string[],
): Promise<string> {
  return runGit(["-C", workspace, ...arguments_]);
}

export async function gitOptional(
  workspace: string,
  arguments_: readonly string[],
): Promise<string> {
  try {
    return await git(workspace, arguments_);
  } catch (error) {
    if ((error as { code?: unknown } | undefined)?.code === 1) return "";
    throw error;
  }
}

export async function gitExit(
  workspace: string,
  arguments_: readonly string[],
): Promise<number> {
  try {
    await git(workspace, arguments_);
    return 0;
  } catch (error) {
    const code = (error as { code?: unknown } | undefined)?.code;
    if (typeof code === "number") return code;
    throw error;
  }
}

export async function gitAuthenticated(
  remote: GitRemote,
  workspace: string,
  arguments_: readonly string[],
  timeout?: number,
): Promise<string> {
  const credential = Buffer.from(`x-access-token:${remote.token}`).toString(
    "base64",
  );
  core.setSecret(credential);
  try {
    return await runGit(
      [
        "-C",
        workspace,
        "-c",
        `http.${remote.serverUrl}/.extraheader=AUTHORIZATION: basic ${credential}`,
        ...arguments_,
      ],
      timeout,
    );
  } catch {
    // execFile errors include the command and can retain its output.
    throw new Error(
      "Authenticated git operation failed; credentials were not included in output",
    );
  }
}

export function repositoryUrl({
  serverUrl,
  repositoryFullName,
}: GitRemote): string {
  return `${serverUrl}/${repositoryFullName}.git`;
}

/** Remove only the expected revision, reconciling a failed push with the remote ref. */
export async function deleteBranch(
  deletion: BranchDeletion,
): Promise<DeleteRefOutcome> {
  if (deletion.workspace !== undefined) {
    return await pushDeletion(deletion, deletion.workspace);
  }

  // Cleanup does not depend on the caller checkout or its local Git config.
  const directory = await mkdtemp(join(tmpdir(), "prek-autoupdate-git-"));
  try {
    await runGit(["init", "--quiet", directory], CLEANUP_TIMEOUT_MS);
    return await pushDeletion(deletion, directory, CLEANUP_TIMEOUT_MS);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function pushDeletion(
  { remote, ref, expectedSha, readRef }: BranchDeletion,
  directory: string,
  timeout?: number,
): Promise<DeleteRefOutcome> {
  try {
    await gitAuthenticated(
      remote,
      directory,
      [
        "push",
        repositoryUrl(remote),
        `:${ref}`,
        `--force-with-lease=${ref}:${expectedSha}`,
      ],
      timeout,
    );
    return "deleted";
  } catch {
    const current = await readRef();
    if (current === undefined) return "already-absent";
    if (current !== expectedSha) return "lease-rejected";
    throw new Error(
      "Lease-protected branch deletion failed; credentials were not included in output",
    );
  }
}

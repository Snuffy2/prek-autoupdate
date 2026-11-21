import * as core from "@actions/core";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { git } from "../git.js";

export interface DetachedWorktree {
  readonly path: string;
  readonly add: () => Promise<void>;
  readonly cleanup: () => Promise<void>;
}

/** Allocate a detached worktree. Clean up even if Git only partially adds it. */
export async function prepareWorktree(
  workspace: string,
  baseSha: string,
): Promise<DetachedWorktree> {
  const root = await createTemporaryRoot();
  const worktree = join(root, "worktree");
  return {
    path: worktree,
    async add() {
      await git(workspace, ["worktree", "add", "--detach", worktree, baseSha]);
    },
    async cleanup() {
      const remove = ["worktree", "remove", "--force", worktree];
      try {
        await git(workspace, remove).catch(() => git(workspace, remove));
      } catch (removalError) {
        await reconcileRemoval(workspace, worktree, removalError);
      }
      await rm(root, { force: true, recursive: true });
    },
  };
}

async function reconcileRemoval(
  workspace: string,
  worktree: string,
  removalError: unknown,
): Promise<void> {
  let registered: boolean;
  try {
    registered = await hasWorktreeRegistration(workspace, worktree);
  } catch (inspectionError) {
    throw new AggregateError(
      [removalError, inspectionError],
      `Failed to reconcile action-owned worktree registration; ${worktree} was preserved for inspection`,
      { cause: inspectionError },
    );
  }
  if (registered) {
    throw new Error(
      `Failed to remove action-owned worktree; ${worktree} was preserved for inspection`,
      { cause: removalError },
    );
  }
  core.warning(
    `Failed to remove action-owned worktree, but its registration was already absent; continuing cleanup: ${String(removalError)}`,
  );
}

async function hasWorktreeRegistration(
  workspace: string,
  worktree: string,
): Promise<boolean> {
  const list = ["worktree", "list", "--porcelain"];
  const entry = `worktree ${worktree}`;
  try {
    const registrations = await git(workspace, [...list, "-z"]);
    return registrations.split("\0").includes(entry);
  } catch (error) {
    const { code, stderr } = error as { code?: unknown; stderr?: unknown };
    // Older Git rejects the fixed list arguments with a usage error.
    if (
      code !== 129 ||
      typeof stderr !== "string" ||
      !stderr.includes("git worktree list [")
    ) {
      throw error;
    }
    // Legacy porcelain prints paths raw, so a newline can split an entry.
    if (worktree.includes("\n")) {
      throw new Error(
        "Legacy Git cannot unambiguously list this worktree path",
        {
          cause: error,
        },
      );
    }
    const registrations = await git(workspace, list);
    return registrations.split("\n").includes(entry);
  }
}

export async function createTemporaryRoot(
  create: (prefix: string) => Promise<string> = mkdtemp,
  resolve: (candidate: string) => Promise<string> = realpath,
  remove: (
    candidate: string,
    options: { force: boolean; recursive: boolean },
  ) => Promise<void> = rm,
): Promise<string> {
  const rawRoot = await create(join(tmpdir(), "prek-autoupdate-"));
  try {
    return await resolve(rawRoot);
  } catch (error) {
    let failure = error;
    try {
      await remove(rawRoot, { force: true, recursive: true });
    } catch (cleanupError) {
      failure = new AggregateError(
        [error, cleanupError],
        "Temporary root resolution failed and cleanup also failed",
        { cause: error },
      );
    }
    throw failure;
  }
}

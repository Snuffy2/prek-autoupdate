import * as core from "@actions/core";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { git } from "../git.js";

interface DetachedWorktree {
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
  let registrations: string;
  try {
    registrations = await git(workspace, [
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
  } catch (inspectionError) {
    throw new AggregateError(
      [removalError, inspectionError],
      `Failed to reconcile action-owned worktree registration; ${worktree} was preserved for inspection`,
      { cause: inspectionError },
    );
  }
  // NUL delimiters keep paths with embedded newlines intact.
  if (registrations.split("\0").includes(`worktree ${worktree}`)) {
    throw new Error(
      `Failed to remove action-owned worktree; ${worktree} was preserved for inspection`,
      { cause: removalError },
    );
  }
  core.warning(
    `Failed to remove action-owned worktree, but its registration was already absent; continuing cleanup: ${String(removalError)}`,
  );
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

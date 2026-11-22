import * as core from "@actions/core";
import * as github from "@actions/github";

import { cleanupUpdateBranches } from "./cleanup/index.js";
import type {
  ActionExecution,
  CleanupResult,
  UpdateResult,
} from "./contracts.js";
import {
  CreatedPullOwnershipError,
  PublishedPullRequestError,
  PublishedUpdateError,
} from "./contracts.js";
import {
  parseInputs,
  resolveContext,
  shouldUpdate,
  validateCheckout,
} from "./input.js";
import {
  runUpdate,
  validateCleanupConfiguration,
  validateUpdateConfiguration,
} from "./update/index.js";
import { versionBanner } from "./version.js";

export async function runAction(now: Date = new Date()): Promise<void> {
  core.info(versionBanner());
  const inputs = parseInputs();
  const client = github.getOctokit(inputs.token);
  const context = await resolveContext(client, inputs);
  const execution: ActionExecution = { client, context, inputs };
  let unverifiedCreatedPull: number | undefined;
  validateCleanupConfiguration(execution);

  const failures: Array<{ readonly phase: string; readonly error: unknown }> =
    [];
  let updateResult: UpdateResult = { operation: "none" };
  let cleanupResult: CleanupResult | undefined;

  try {
    await validateCheckout(context);
    await validateUpdateConfiguration(execution);
    if (shouldUpdate(context.eventName, inputs.updateDay, now)) {
      updateResult = await runUpdate(execution);
    } else {
      core.info(
        `Skipping prek autoupdate for ${context.eventName}; cleanup will still run.`,
      );
    }
  } catch (error: unknown) {
    if (error instanceof PublishedPullRequestError) {
      updateResult = error.publishedPullRequest;
    } else if (error instanceof PublishedUpdateError) {
      updateResult = error.publishedPullRequest;
    }
    const updateCause = error instanceof AggregateError ? error.cause : error;
    if (updateCause instanceof CreatedPullOwnershipError) {
      unverifiedCreatedPull = updateCause.pullRequestNumber;
    }
    failures.push({ phase: "update", error });
  } finally {
    try {
      cleanupResult = await cleanupUpdateBranches(execution, {
        keepPullRequestNumber:
          unverifiedCreatedPull ?? updateResult.pullRequestNumber,
        ...(unverifiedCreatedPull === undefined
          ? {}
          : { keepBranch: inputs.updateBranch }),
        keepLatestOpenPullRequest: updateResult.pullRequestNumber === undefined,
        closeStalePullRequests: context.eventName !== "push",
        closeObsoletePullRequests: context.eventName === "push",
        deleteStaleBranches: true,
        deleteMergedBranches: true,
      });
    } catch (error: unknown) {
      failures.push({ phase: "cleanup", error });
    }
  }

  core.setOutput(
    "pull-request-number",
    updateResult.pullRequestNumber?.toString() ?? "",
  );
  if (updateResult.cleanup !== undefined || cleanupResult !== undefined) {
    const closedPullRequests = [
      ...new Set([
        ...(updateResult.cleanup?.closedPullRequests ?? []),
        ...(cleanupResult?.closedPullRequests ?? []),
      ]),
    ];
    const deletedBranches = [
      ...new Set([
        ...(updateResult.cleanup?.deletedBranches ?? []),
        ...(cleanupResult?.deletedBranches ?? []),
      ]),
    ];
    core.info(
      `Closed PRs: ${
        closedPullRequests.length === 0 ? "none" : closedPullRequests.join(", ")
      }`,
    );
    core.info(
      `Deleted branches: ${
        deletedBranches.length === 0 ? "none" : deletedBranches.join(", ")
      }`,
    );
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      core.error(`${failure.phase} failed: ${errorMessage(failure.error)}`);
    }
    core.setFailed(
      failures
        .map((failure) => `${failure.phase}: ${errorMessage(failure.error)}`)
        .join("; "),
    );
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof AggregateError) {
    const details = [...error.errors].map((cause) => errorMessage(cause));
    return details.length === 0
      ? error.message
      : `${error.message}: ${details.join("; ")}`;
  }
  if (error instanceof Error) {
    return error.cause === undefined
      ? error.message
      : `${error.message}: ${errorMessage(error.cause)}`;
  }
  return String(error);
}

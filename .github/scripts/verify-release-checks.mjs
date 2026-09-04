#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export class GitHubCommandError extends Error {}

export function githubApi(arguments_, expectedStatus) {
  const result = spawnSync("gh", ["api", ...arguments_], {
    encoding: "utf8",
    env: process.env,
    timeout: 30_000,
  });
  if (result.error) {
    throw new GitHubCommandError(
      result.error.code === "ETIMEDOUT"
        ? "GitHub API request timed out."
        : `Unable to run GitHub CLI: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new GitHubCommandError(
      result.stderr.trim() ||
        result.stdout.trim() ||
        "GitHub API request failed.",
    );
  }

  let output = result.stdout;
  if (expectedStatus !== undefined) {
    const normalized = output.replaceAll("\r\n", "\n");
    const separator = normalized.indexOf("\n\n");
    const header =
      separator === -1 ? normalized : normalized.slice(0, separator);
    const status = /^HTTP\/\S+\s+(\d{3})/u.exec(header)?.[1];
    if (separator === -1 || status !== String(expectedStatus)) {
      throw new GitHubCommandError(
        `GitHub API returned an unexpected HTTP response: ${JSON.stringify(header)}.`,
      );
    }
    output = normalized.slice(separator + 2);
  }
  if (!output.trim()) return {};
  const payload = JSON.parse(output);
  if (
    payload === null ||
    Array.isArray(payload) ||
    typeof payload !== "object"
  ) {
    throw new GitHubCommandError("GitHub API response was not an object.");
  }
  return payload;
}

export function dispatchWorkflow(
  repository,
  workflow,
  ref,
  sha,
  api = githubApi,
) {
  const response = api(
    [
      "--include",
      "--method",
      "POST",
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      "X-GitHub-Api-Version: 2026-03-10",
      `repos/${repository}/actions/workflows/${workflow}/dispatches`,
      "-F",
      "return_run_details=true",
      "-f",
      `ref=${ref}`,
      "-f",
      `inputs[expected_sha]=${sha}`,
    ],
    200,
  );
  const runId = response.workflow_run_id;
  if (!Number.isInteger(runId) || runId <= 0) {
    throw new GitHubCommandError(
      "Dispatch response did not contain a valid workflow_run_id.",
    );
  }
  return runId;
}

export function verifyCheckSuite(repository, run, sha, api = githubApi) {
  if (!Number.isInteger(run.check_suite_id)) {
    throw new GitHubCommandError(
      "Workflow run did not expose a check suite ID.",
    );
  }
  const suite = api([
    `repos/${repository}/check-suites/${String(run.check_suite_id)}`,
  ]);
  if (suite.head_sha !== sha || suite.app?.slug !== "github-actions") {
    throw new GitHubCommandError(
      "Workflow run is not a GitHub Actions check suite for the candidate commit.",
    );
  }
}

export function verifyJobs(repository, runId, requiredChecks, api = githubApi) {
  const payload = api([
    `repos/${repository}/actions/runs/${String(runId)}/jobs?per_page=100`,
  ]);
  const jobs = payload.jobs;
  if (
    !Array.isArray(jobs) ||
    !Number.isInteger(payload.total_count) ||
    payload.total_count > jobs.length
  ) {
    throw new GitHubCommandError(
      "Workflow job list was truncated or unverifiable.",
    );
  }
  const outcomes = new Map();
  for (const job of jobs) {
    if (
      job !== null &&
      typeof job === "object" &&
      typeof job.name === "string"
    ) {
      const values = outcomes.get(job.name) ?? [];
      values.push(job.conclusion);
      outcomes.set(job.name, values);
    }
  }
  const missing = [...requiredChecks]
    .filter((name) => !outcomes.has(name))
    .sort();
  const duplicate = [...requiredChecks]
    .filter((name) => (outcomes.get(name)?.length ?? 0) > 1)
    .sort();
  const unsuccessful = [...requiredChecks]
    .filter((name) => {
      const values = outcomes.get(name);
      return values?.length === 1 && values[0] !== "success";
    })
    .sort();
  if (missing.length || duplicate.length || unsuccessful.length) {
    throw new GitHubCommandError(
      `Required checks missing=${JSON.stringify(missing)}, duplicate=${JSON.stringify(duplicate)}, unsuccessful=${JSON.stringify(unsuccessful)}.`,
    );
  }
}

export function publishVerifiedStatus(
  repository,
  sha,
  check,
  runId,
  api = githubApi,
) {
  const response = api([
    "--method",
    "POST",
    "-H",
    "Accept: application/vnd.github+json",
    "-H",
    "X-GitHub-Api-Version: 2026-03-10",
    `repos/${repository}/statuses/${sha}`,
    "-f",
    "state=success",
    "-f",
    `context=${check}`,
    "-f",
    `description=Verified by release workflow run ${String(runId)}`,
    "-f",
    `target_url=https://github.com/${repository}/actions/runs/${String(runId)}`,
  ]);
  if (response.state !== "success" || response.context !== check) {
    throw new GitHubCommandError(
      `GitHub did not confirm verified status ${JSON.stringify(check)}.`,
    );
  }
}

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function waitForWorkflow({
  repository,
  workflow,
  ref,
  sha,
  requiredChecks,
  deadline,
  expectedRunId,
  api = githubApi,
  sleep = delay,
  now = () => Date.now(),
}) {
  const metadata = api([`repos/${repository}/actions/workflows/${workflow}`]);
  if (!Number.isInteger(metadata.id)) {
    throw new GitHubCommandError(
      `Workflow ${JSON.stringify(workflow)} has no numeric ID.`,
    );
  }
  while (now() < deadline) {
    let run;
    try {
      run = api([`repos/${repository}/actions/runs/${String(expectedRunId)}`]);
    } catch (error) {
      if (
        !(error instanceof GitHubCommandError) ||
        !error.message.includes("404")
      ) {
        throw error;
      }
      await sleep(5_000);
      continue;
    }
    if (run.id !== expectedRunId) {
      throw new GitHubCommandError(
        "Workflow run ID does not match the dispatch response.",
      );
    }
    if (
      run.workflow_id !== metadata.id ||
      run.event !== "workflow_dispatch" ||
      run.head_branch !== ref ||
      run.head_sha !== sha
    ) {
      throw new GitHubCommandError(
        "Workflow run does not match the dispatched identity.",
      );
    }
    if (run.status !== "completed") {
      await sleep(10_000);
      continue;
    }
    if (run.conclusion !== "success") {
      throw new GitHubCommandError(
        `Workflow ${JSON.stringify(workflow)} run ${String(expectedRunId)} concluded ${JSON.stringify(run.conclusion)}.`,
      );
    }
    verifyCheckSuite(repository, run, sha, api);
    verifyJobs(repository, expectedRunId, requiredChecks, api);
    return expectedRunId;
  }
  throw new GitHubCommandError(
    `Timed out waiting for workflow ${JSON.stringify(workflow)}.`,
  );
}

export function parseRequiredChecks(values) {
  const checks = new Map();
  for (const value of values) {
    const separator = value.indexOf("::");
    if (separator <= 0 || separator + 2 >= value.length) {
      throw new TypeError("Required checks must use workflow::exact job name.");
    }
    const workflow = value.slice(0, separator);
    const check = value.slice(separator + 2);
    const names = checks.get(workflow) ?? new Set();
    names.add(check);
    checks.set(workflow, names);
  }
  return checks;
}

function parseArguments(arguments_) {
  const values = { requiredChecks: [] };
  for (let index = 0; index < arguments_.length; index += 2) {
    const option = arguments_[index];
    const value = arguments_[index + 1];
    if (!option?.startsWith("--") || value === undefined) {
      throw new TypeError(
        "Release check arguments must use --option value pairs.",
      );
    }
    if (option === "--required-check") values.requiredChecks.push(value);
    else if (option === "--repository") values.repository = value;
    else if (option === "--ref") values.ref = value;
    else if (option === "--sha") values.sha = value;
    else if (option === "--timeout-seconds")
      values.timeoutSeconds = Number(value);
    else throw new TypeError(`Unknown option: ${option}`);
  }
  if (
    !values.repository ||
    !values.ref ||
    !values.sha ||
    !values.requiredChecks.length
  ) {
    throw new TypeError(
      "--repository, --ref, --sha, and at least one --required-check are required.",
    );
  }
  if (!/^[0-9a-f]{40}$/u.test(values.sha)) {
    throw new TypeError("--sha must be a lowercase 40-character commit ID.");
  }
  values.timeoutSeconds ??= 1_800;
  if (!Number.isInteger(values.timeoutSeconds) || values.timeoutSeconds <= 0) {
    throw new TypeError("--timeout-seconds must be a positive integer.");
  }
  return values;
}

export async function main(arguments_ = process.argv.slice(2)) {
  const options = parseArguments(arguments_);
  const checks = parseRequiredChecks(options.requiredChecks);
  const dispatched = new Map(
    [...checks].map(([workflow]) => [
      workflow,
      dispatchWorkflow(options.repository, workflow, options.ref, options.sha),
    ]),
  );
  const deadline = Date.now() + options.timeoutSeconds * 1_000;
  const verifiedRuns = new Map();
  for (const [workflow, requiredChecks] of checks) {
    const runId = await waitForWorkflow({
      repository: options.repository,
      workflow,
      ref: options.ref,
      sha: options.sha,
      requiredChecks,
      deadline,
      expectedRunId: dispatched.get(workflow),
    });
    verifiedRuns.set(workflow, runId);
    process.stdout.write(
      `Verified ${workflow} run ${String(runId)} for ${options.sha}.\n`,
    );
  }
  for (const [workflow, requiredChecks] of checks) {
    const runId = verifiedRuns.get(workflow);
    for (const check of [...requiredChecks].sort()) {
      publishVerifiedStatus(options.repository, options.sha, check, runId);
      process.stdout.write(
        `Published verified status ${JSON.stringify(check)} for ${options.sha}.\n`,
      );
    }
  }
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main().catch((error) => {
    process.stderr.write(
      `Release check verification failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}

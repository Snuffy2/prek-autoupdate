import type { Payload } from "../github.js";
import {
  isOwnedPull,
  isSameRepository,
  type OwnershipPolicy,
} from "../ownership.js";
import type { ClosedPullCandidate, CompensatablePull } from "./model.js";

export function pullNumber(pull: Payload): number {
  const value = pull.number;
  if (typeof value === "number" && Number.isInteger(value) && value > 0)
    return value;
  if (typeof value === "string" && /^[1-9]\d*$/u.test(value))
    return Number(value);
  throw new TypeError("Pull request is missing a numeric number");
}

export function pullChangedFiles(pull: Payload): number {
  const value = pull.changed_files;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TypeError("Pull request is missing a valid changed file count");
  }
  return value;
}

function nestedString(
  pull: Payload,
  key: "base" | "head",
  field: "ref" | "sha",
): string | undefined {
  return stringValue(objectField(pull[key], field));
}

export const pullHeadSha = (pull: Payload): string | undefined =>
  nestedString(pull, "head", "sha");
export const pullHeadRef = (pull: Payload): string | undefined =>
  nestedString(pull, "head", "ref");
export const pullBaseRef = (pull: Payload): string | undefined =>
  nestedString(pull, "base", "ref");

export function headRef(pull: Payload): string {
  const ref = pullHeadRef(pull);
  if (ref === undefined)
    throw new TypeError("Pull request is missing a head ref");
  return ref;
}

export function sameRepoHeadRef(
  pull: Payload,
  repository: string,
): string | undefined {
  return isSameRepository(pullHeadRepository(pull), repository)
    ? pullHeadRef(pull)
    : undefined;
}

function objectField(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Payload)[key]
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function pullHeadRepository(pull: Payload): string | undefined {
  return stringValue(objectField(objectField(pull.head, "repo"), "full_name"));
}

export function isWorkflowPull(
  pull: Payload,
  policy: OwnershipPolicy,
): boolean {
  return isOwnedPull(
    {
      author: stringValue(objectField(pull.user, "login")),
      body: stringValue(pull.body),
      headRef: pullHeadRef(pull),
      headRepository: pullHeadRepository(pull),
      baseRef: pullBaseRef(pull),
      labels: Array.isArray(pull.labels)
        ? pull.labels
            .map((label) => objectField(label, "name"))
            .filter((name) => typeof name === "string")
        : [],
    },
    policy,
    "update-branch-or-prefix",
  );
}

export function closeIdentity(pull: Payload): CompensatablePull | undefined {
  const number = pull.number;
  const changedFiles = pull.changed_files;
  const headSha = pullHeadSha(pull);
  const head = pullHeadRef(pull);
  const base = pullBaseRef(pull);
  if (
    typeof number !== "number" ||
    !Number.isInteger(number) ||
    pull.state !== "closed" ||
    (pull.merged_at !== null && pull.merged_at !== undefined) ||
    typeof changedFiles !== "number" ||
    !Number.isInteger(changedFiles) ||
    changedFiles < 0 ||
    typeof pull.updated_at !== "string" ||
    typeof pull.closed_at !== "string" ||
    headSha === undefined ||
    head === undefined ||
    base === undefined
  )
    return undefined;
  return {
    number,
    headSha,
    headRef: head,
    baseRef: base,
    changedFiles,
    updatedAt: pull.updated_at,
    closedAt: pull.closed_at,
  };
}

export function closedDeletionIdentity(
  pull: Payload,
): ClosedPullCandidate | undefined {
  const number = pull.number;
  const ref = pullHeadRef(pull);
  const sha = pullHeadSha(pull);
  if (
    typeof number !== "number" ||
    !Number.isInteger(number) ||
    ref === undefined ||
    sha === undefined ||
    typeof pull.updated_at !== "string"
  )
    return undefined;
  return {
    number,
    headRef: ref,
    headSha: sha,
    updatedAt: pull.updated_at,
    merged: pull.merged_at !== null && pull.merged_at !== undefined,
  };
}

export function sameCandidate(
  left: ClosedPullCandidate,
  right: ClosedPullCandidate,
): boolean {
  return (
    left.number === right.number &&
    left.headRef === right.headRef &&
    left.headSha === right.headSha &&
    left.updatedAt === right.updatedAt &&
    left.merged === right.merged
  );
}

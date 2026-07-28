import type {
  ClosedPullCandidate,
  CompensatablePull,
  OwnershipPolicy,
  Payload,
} from "./model.js";

export function payload(value: unknown, description: string): Payload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Expected ${description}`);
  }
  return value as Payload;
}

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
  const nested = pull[key];
  if (nested === null || typeof nested !== "object" || Array.isArray(nested))
    return undefined;
  const value = (nested as Payload)[field];
  return typeof value === "string" ? value : undefined;
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
  const head = pull.head;
  if (head === null || typeof head !== "object" || Array.isArray(head))
    return undefined;
  const headPayload = head as Payload;
  const repo = headPayload.repo;
  if (repo === null || typeof repo !== "object" || Array.isArray(repo))
    return undefined;
  return (repo as Payload).full_name === repository &&
    typeof headPayload.ref === "string"
    ? headPayload.ref
    : undefined;
}

export function isWorkflowPull(
  pull: Payload,
  policy: OwnershipPolicy,
): boolean {
  const labels = pull.labels;
  if (
    !Array.isArray(labels) ||
    !labels.some(
      (label) =>
        label !== null &&
        typeof label === "object" &&
        !Array.isArray(label) &&
        (label as Payload).name === policy.labelName,
    )
  )
    return false;
  const user = pull.user;
  if (
    user === null ||
    typeof user !== "object" ||
    Array.isArray(user) ||
    (user as Payload).login !== policy.authorLogin
  )
    return false;
  if (typeof pull.body !== "string" || !pull.body.includes(policy.bodyMarker))
    return false;
  const ref = sameRepoHeadRef(pull, policy.repository);
  return (
    ref !== undefined &&
    (ref === policy.branch || ref.startsWith(policy.branchPrefix))
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

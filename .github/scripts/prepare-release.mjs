import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const PRERELEASE_IDENTIFIER =
  "(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)";
const SEMVER_PATTERN = new RegExp(
  `^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-(${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*))?$`,
);

function compare(left, right) {
  for (let index = 1; index <= 3; index += 1) {
    const leftPart = BigInt(left[index]);
    const rightPart = BigInt(right[index]);
    if (leftPart < rightPart) return -1;
    if (leftPart > rightPart) return 1;
  }
  const leftPrerelease = left[4];
  const rightPrerelease = right[4];
  if (leftPrerelease === undefined)
    return rightPrerelease === undefined ? 0 : 1;
  if (rightPrerelease === undefined) return -1;

  const leftParts = leftPrerelease.split(".");
  const rightParts = rightPrerelease.split(".");
  for (
    let index = 0;
    index < Math.max(leftParts.length, rightParts.length);
    index += 1
  ) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^[0-9]+$/.test(leftPart);
    const rightNumeric = /^[0-9]+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      return BigInt(leftPart) < BigInt(rightPart) ? -1 : 1;
    }
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function main() {
  const releaseTag = process.env.RELEASE_TAG ?? "";
  const match = SEMVER_PATTERN.exec(releaseTag);
  if (!match) {
    throw new Error(
      "Release tag must have vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-PRERELEASE form",
    );
  }

  const version = releaseTag.slice(1);
  const packagePath = process.env.PACKAGE_JSON_PATH ?? "package.json";
  const lockPath = process.env.PACKAGE_LOCK_PATH ?? "package-lock.json";
  const packageJson = readJson(packagePath);
  const packageLock = readJson(lockPath);
  const currentMatch = SEMVER_PATTERN.exec(`v${String(packageJson.version)}`);
  if (!currentMatch) {
    throw new Error("package.json must contain a semantic version");
  }
  if (compare(match, currentMatch) < 0) {
    throw new Error(
      `Release ${releaseTag} would downgrade package.json from ${String(packageJson.version)}`,
    );
  }

  packageJson.version = version;
  packageLock.version = version;
  if (!packageLock.packages?.[""]) {
    throw new Error("package-lock.json is missing the root package");
  }
  packageLock.packages[""].version = version;
  writeJson(packagePath, packageJson);
  writeJson(lockPath, packageLock);

  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
    throw new Error("Release source SHA is invalid");
  }

  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    throw new Error("GITHUB_OUTPUT is required");
  }
  appendFileSync(
    outputPath,
    `major-tag=v${match[1]}\nsource-sha=${sourceSha}\n`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

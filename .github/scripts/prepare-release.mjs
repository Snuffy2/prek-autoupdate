import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const SEMVER_PATTERN = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

function compare(left, right) {
  for (let index = 0; index < 3; index += 1) {
    const leftPart = BigInt(left[index]);
    const rightPart = BigInt(right[index]);
    if (leftPart < rightPart) return -1;
    if (leftPart > rightPart) return 1;
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
    throw new Error("Release tag must have vMAJOR.MINOR.PATCH form");
  }

  const version = releaseTag.slice(1);
  const packagePath = process.env.PACKAGE_JSON_PATH ?? "package.json";
  const lockPath = process.env.PACKAGE_LOCK_PATH ?? "package-lock.json";
  const packageJson = readJson(packagePath);
  const packageLock = readJson(lockPath);
  const currentMatch = SEMVER_PATTERN.exec(`v${String(packageJson.version)}`);
  if (!currentMatch) {
    throw new Error("package.json must contain a stable semantic version");
  }
  if (compare(match.slice(1), currentMatch.slice(1)) < 0) {
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

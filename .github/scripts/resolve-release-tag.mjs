import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

const STABLE_SEMVER_PATTERN =
  /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const BUMP_TYPES = new Set(["none", "patch", "minor", "major"]);

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function compareVersions(left, right) {
  for (let index = 1; index <= 3; index += 1) {
    const leftPart = BigInt(left[index]);
    const rightPart = BigInt(right[index]);
    if (leftPart < rightPart) return -1;
    if (leftPart > rightPart) return 1;
  }
  return 0;
}

function writeReleaseTag(releaseTag) {
  appendFileSync(required("GITHUB_OUTPUT"), `release-tag=${releaseTag}\n`);
}

function readPersistedTag(path) {
  let persistedTag;
  try {
    persistedTag = readFileSync(path, "utf8").trim();
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new Error("Unable to read persisted automatic release tag", {
      cause: error,
    });
  }
  if (!STABLE_SEMVER_PATTERN.test(persistedTag)) {
    throw new Error("Persisted automatic release tag is invalid");
  }
  return persistedTag;
}

function persistReleaseTag(path, releaseTag) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${releaseTag}\n`);
}

function main() {
  const explicitTag = process.env.EXPLICIT_TAG?.trim() ?? "";
  const isPrerelease = process.env.IS_PRERELEASE?.trim() ?? "";
  const bumpType = process.env.BUMP_TYPE?.trim() ?? "none";
  const persistedTagPath = process.env.PERSISTED_TAG_PATH?.trim() ?? "";
  const requirePersistedTag =
    process.env.REQUIRE_PERSISTED_TAG?.trim() ?? "false";
  if (isPrerelease !== "true" && isPrerelease !== "false") {
    throw new Error("IS_PRERELEASE must be true or false");
  }
  if (!BUMP_TYPES.has(bumpType)) {
    throw new Error("BUMP_TYPE must be none, patch, minor, or major");
  }
  if (requirePersistedTag !== "true" && requirePersistedTag !== "false") {
    throw new Error("REQUIRE_PERSISTED_TAG must be true or false");
  }

  if (explicitTag || isPrerelease === "true") {
    if (!explicitTag) {
      throw new Error("Prereleases require an explicit release tag");
    }
    writeReleaseTag(explicitTag);
    return;
  }
  if (bumpType === "none") {
    throw new Error("Provide an explicit release tag or select a version bump");
  }

  if (persistedTagPath) {
    const persistedTag = readPersistedTag(persistedTagPath);
    if (persistedTag) {
      writeReleaseTag(persistedTag);
      return;
    }
  }
  if (requirePersistedTag === "true") {
    throw new Error("Persisted automatic release tag is missing");
  }

  const repository = required("GITHUB_REPOSITORY");
  const output = execFileSync(
    "gh",
    [
      "api",
      "--paginate",
      "--slurp",
      `repos/${repository}/releases?per_page=100`,
    ],
    { encoding: "utf8", env: process.env },
  );
  const pages = JSON.parse(output);
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new Error("GitHub releases response has an unexpected shape");
  }
  const versions = pages
    .flat()
    .filter(
      (release) =>
        release?.draft === false &&
        release.prerelease === false &&
        typeof release.published_at === "string",
    )
    .map((release) => STABLE_SEMVER_PATTERN.exec(release.tag_name ?? ""))
    .filter((match) => match !== null);
  if (versions.length === 0) {
    throw new Error(
      "No published stable semantic release is available to bump",
    );
  }
  const previous = versions.reduce((highest, candidate) =>
    compareVersions(candidate, highest) > 0 ? candidate : highest,
  );
  let major = BigInt(previous[1]);
  let minor = BigInt(previous[2]);
  let patch = BigInt(previous[3]);
  if (bumpType === "patch") {
    patch += 1n;
  } else if (bumpType === "minor") {
    minor += 1n;
    patch = 0n;
  } else {
    major += 1n;
    minor = 0n;
    patch = 0n;
  }
  const releaseTag = `v${major}.${minor}.${patch}`;
  if (persistedTagPath) persistReleaseTag(persistedTagPath, releaseTag);
  writeReleaseTag(releaseTag);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

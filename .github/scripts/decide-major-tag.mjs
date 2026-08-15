import { readFileSync } from "node:fs";

const SEMVER_PATTERN = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

function compare(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

function decide() {
  const releaseTag = process.env.RELEASE_TAG ?? "";
  const targetSha = process.env.TARGET_SHA ?? "";
  const releaseMatch = SEMVER_PATTERN.exec(releaseTag);
  if (!releaseMatch) {
    throw new Error("Release tag must have vMAJOR.MINOR.PATCH form");
  }
  if (!/^[0-9a-f]{40}$/.test(targetSha)) {
    throw new Error("Verified release SHA is invalid");
  }

  const tagPages = JSON.parse(readFileSync(process.env.TAGS_FILE, "utf8"));
  const releasePages = JSON.parse(
    readFileSync(process.env.RELEASES_FILE, "utf8"),
  );
  const tags = tagPages.flat();
  const releases = releasePages.flat();
  const releaseVersion = releaseMatch.slice(1).map(BigInt);
  const majorTag = `v${releaseMatch[1]}`;
  const eligibleReleases = releases.filter(
    (release) =>
      release.draft === false &&
      release.prerelease === false &&
      release.published_at &&
      SEMVER_PATTERN.test(release.tag_name),
  );
  const triggeringRelease = eligibleReleases.find(
    (release) => release.tag_name === releaseTag,
  );
  if (!triggeringRelease) {
    throw new Error("Triggering release is not a published stable release");
  }

  const stableTags = eligibleReleases.flatMap((release) => {
    const match = SEMVER_PATTERN.exec(release.tag_name);
    if (BigInt(match[1]) !== releaseVersion[0]) return [];
    const tag = tags.find((candidate) => candidate.name === release.tag_name);
    if (!tag) {
      throw new Error(
        `Published stable release ${release.tag_name} has no matching tag`,
      );
    }
    return [
      {
        name: tag.name,
        sha: tag.commit.sha,
        version: match.slice(1).map(BigInt),
      },
    ];
  });
  const releaseRef = stableTags.find((tag) => tag.name === releaseTag);
  if (!releaseRef) {
    throw new Error("Verified release tag is missing from the stable tag list");
  }

  const current = tags.find((tag) => tag.name === majorTag);
  if (!current) return `create\t${targetSha}`;
  if (current.commit.sha === targetSha) return "noop\t";

  const currentVersions = stableTags.filter(
    (tag) => tag.sha === current.commit.sha,
  );
  if (currentVersions.length === 0) {
    throw new Error(
      `${majorTag} does not point to a known immutable stable release`,
    );
  }
  const currentVersion = currentVersions.reduce((left, right) =>
    compare(left.version, right.version) >= 0 ? left : right,
  );
  if (compare(releaseVersion, currentVersion.version) < 0) return "skip\t";
  return `update\t${targetSha}\t${current.commit.sha}`;
}

try {
  process.stdout.write(decide());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

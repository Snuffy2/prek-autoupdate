import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PRERELEASE_IDENTIFIER =
  "(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)";
const SEMVER_PATTERN = new RegExp(
  `^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-(${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*))?$`,
);
const RELEASE_FILES = ["dist/index.js", "package-lock.json", "package.json"];

function git(args, options = {}) {
  const { env, ...execOptions } = options;
  const result = execFileSync("git", args, {
    cwd: process.env.RELEASE_DIRECTORY,
    encoding: "utf8",
    ...execOptions,
    env: { ...process.env, ...env },
  });
  return typeof result === "string" ? result.trim() : "";
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function validatePreparedFile(root, relativePath) {
  const path = join(root, relativePath);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(
      `Prepared release path is not a regular file: ${relativePath}`,
    );
  }
  if (stat.size > 10 * 1024 * 1024) {
    throw new Error(`Prepared release path is too large: ${relativePath}`);
  }
  return path;
}

function remoteRefs(defaultBranch, releaseTag) {
  const output = git([
    "ls-remote",
    "origin",
    `refs/heads/${defaultBranch}`,
    `refs/tags/${releaseTag}`,
    `refs/tags/${releaseTag}^{}`,
  ]);
  const refs = new Map(
    output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [oid, ref] = line.split("\t");
        return [ref, oid];
      }),
  );
  const branchOid = refs.get(`refs/heads/${defaultBranch}`);
  const tagOid = refs.get(`refs/tags/${releaseTag}`);
  const tagCommitOid = refs.get(`refs/tags/${releaseTag}^{}`) ?? tagOid;
  if (!branchOid) {
    throw new Error("Default branch is missing");
  }
  if ((tagOid && !tagCommitOid) || (!tagOid && tagCommitOid)) {
    throw new Error("Release tag is incomplete");
  }
  return { branchOid, tagCommitOid, tagOid };
}

function validateExistingTag(releaseTag, sourceSha, tagCommitOid, tagOid) {
  if (tagCommitOid === tagOid) {
    throw new Error("Existing release tag is not annotated");
  }
  git(["fetch", "--no-tags", "origin", `refs/tags/${releaseTag}`]);
  if (tagCommitOid !== sourceSha) {
    const ancestry = git(["rev-list", "--parents", "-n", "1", tagCommitOid])
      .split(" ")
      .filter(Boolean);
    const expectedSubject = `Updating to version ${releaseTag} [skip ci]`;
    if (
      ancestry.length !== 2 ||
      ancestry[0] !== tagCommitOid ||
      ancestry[1] !== sourceSha ||
      git(["log", "-1", "--format=%s", tagCommitOid]) !== expectedSubject
    ) {
      throw new Error(
        "Existing release tag is not the expected release commit",
      );
    }
  }
  try {
    git(["diff", "--quiet", tagCommitOid, "--", ...RELEASE_FILES]);
  } catch {
    throw new Error("Existing release tag has different release files");
  }
}

function main() {
  const defaultBranch = required("DEFAULT_BRANCH");
  const outputPath = required("GITHUB_OUTPUT");
  const preparedDirectory = required("PREPARED_DIRECTORY");
  const releaseDirectory = required("RELEASE_DIRECTORY");
  const releaseTag = required("RELEASE_TAG");
  const sourceSha = required("SOURCE_SHA");
  const token = required("GH_TOKEN");
  if (!SEMVER_PATTERN.test(releaseTag)) {
    throw new Error(
      "Release tag must have vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-PRERELEASE form",
    );
  }
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
    throw new Error("Release source SHA is invalid");
  }
  if (git(["status", "--porcelain"])) {
    throw new Error("Release checkout must start clean");
  }

  for (const relativePath of RELEASE_FILES) {
    const source = validatePreparedFile(preparedDirectory, relativePath);
    copyFileSync(source, join(releaseDirectory, relativePath));
  }
  const packageJson = JSON.parse(
    readFileSync(join(releaseDirectory, "package.json"), "utf8"),
  );
  const packageLock = JSON.parse(
    readFileSync(join(releaseDirectory, "package-lock.json"), "utf8"),
  );
  const version = releaseTag.slice(1);
  if (
    packageJson.version !== version ||
    packageLock.version !== version ||
    packageLock.packages?.[""]?.version !== version
  ) {
    throw new Error("Prepared package versions do not match the release tag");
  }

  const changedPaths = git(["diff", "--name-only"]).split("\n").filter(Boolean);
  const unexpected = changedPaths.filter(
    (path) => !RELEASE_FILES.includes(path),
  );
  if (unexpected.length > 0) {
    throw new Error(`Unexpected prepared path: ${unexpected[0]}`);
  }

  const refs = remoteRefs(defaultBranch, releaseTag);
  if (refs.branchOid !== sourceSha) {
    throw new Error("Default branch advanced during preparation");
  }
  if (refs.tagCommitOid !== undefined && refs.tagOid !== undefined) {
    validateExistingTag(releaseTag, sourceSha, refs.tagCommitOid, refs.tagOid);
    appendFileSync(outputPath, `sha=${refs.tagCommitOid}\n`);
    return;
  }

  git(["add", "--", ...RELEASE_FILES]);
  let releaseSha = sourceSha;
  try {
    git(["diff", "--cached", "--quiet"]);
  } catch (error) {
    if (error?.status !== 1) throw error;
    // Exit status 1 means the release commit still needs to be created.
    git(["config", "user.name", "github-actions[bot]"]);
    git([
      "config",
      "user.email",
      "41898282+github-actions[bot]@users.noreply.github.com",
    ]);
    git(["commit", "-m", `Updating to version ${releaseTag} [skip ci]`], {
      stdio: "inherit",
    });
    releaseSha = git(["rev-parse", "HEAD"]);
    if (!/^[0-9a-f]{40}$/.test(releaseSha)) {
      throw new Error("Prepared release SHA is invalid");
    }
  }

  const authorization = Buffer.from(`x-access-token:${token}`).toString(
    "base64",
  );
  git(["tag", "-a", releaseTag, "-m", `Release ${releaseTag}`, releaseSha]);
  try {
    git(
      [
        "push",
        `--force-with-lease=refs/tags/${releaseTag}:`,
        "origin",
        `refs/tags/${releaseTag}:refs/tags/${releaseTag}`,
      ],
      {
        env: {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.extraheader",
          GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${authorization}`,
        },
        stdio: "inherit",
      },
    );
  } catch {
    throw new Error("Release tag update failed");
  }
  appendFileSync(outputPath, `sha=${releaseSha}\n`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

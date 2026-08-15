import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SEMVER_PATTERN = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
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
  if (!branchOid || !tagOid || !tagCommitOid) {
    throw new Error("Release branch or tag is missing");
  }
  return { branchOid, tagCommitOid, tagOid };
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
    throw new Error("Release tag must have vMAJOR.MINOR.PATCH form");
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
  if (refs.branchOid !== sourceSha || refs.tagCommitOid !== sourceSha) {
    throw new Error(
      "Default branch or release tag advanced during preparation",
    );
  }

  git(["add", "--", ...RELEASE_FILES]);
  try {
    git(["diff", "--cached", "--quiet"]);
    appendFileSync(outputPath, `sha=${sourceSha}\n`);
    return;
  } catch (error) {
    if (error?.status !== 1) throw error;
    // Exit status 1 means the release commit still needs to be created.
  }

  git(["config", "user.name", "github-actions[bot]"]);
  git([
    "config",
    "user.email",
    "41898282+github-actions[bot]@users.noreply.github.com",
  ]);
  git(["commit", "-m", `Updating to version ${releaseTag} [skip ci]`], {
    stdio: "inherit",
  });
  const releaseSha = git(["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40}$/.test(releaseSha)) {
    throw new Error("Prepared release SHA is invalid");
  }

  const authorization = Buffer.from(`x-access-token:${token}`).toString(
    "base64",
  );
  try {
    git(
      [
        "push",
        "--atomic",
        `--force-with-lease=refs/heads/${defaultBranch}:${refs.branchOid}`,
        `--force-with-lease=refs/tags/${releaseTag}:${refs.tagOid}`,
        "origin",
        `HEAD:refs/heads/${defaultBranch}`,
        `+HEAD:refs/tags/${releaseTag}`,
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
    throw new Error("Atomic release branch and tag update failed");
  }
  appendFileSync(outputPath, `sha=${releaseSha}\n`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

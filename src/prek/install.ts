import * as toolCache from "@actions/tool-cache";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const LATEST_RELEASE_URL = "https://github.com/j178/prek/releases/latest";
const RELEASE_ROOT = "https://github.com/j178/prek/releases/download";
const RELEASE_PATH_PATTERN =
  /^\/j178\/prek\/releases\/tag\/v(0|[1-9][0-9]*)\.([0-9]+)\.([0-9]+)$/u;

interface Release {
  readonly root: string;
  readonly target: string;
  readonly version: string;
}

export interface PrekInstallation {
  readonly binary: string;
  readonly cleanup: () => Promise<void>;
}

export function targetForArchitecture(
  architecture: NodeJS.Architecture,
): string {
  if (architecture === "x64") {
    return "x86_64-unknown-linux-gnu";
  }
  if (architecture === "arm64") {
    return "aarch64-unknown-linux-gnu";
  }
  throw new Error(`Unsupported prek architecture: ${architecture}`);
}

/** Install the latest official prek release and transfer cleanup ownership. */
export async function installPrek(): Promise<PrekInstallation> {
  const latest = await resolveLatestRelease(
    targetForArchitecture(process.arch),
  );
  const asset = `prek-${latest.target}.tar.gz`;
  const directory = await mkdtemp(path.join(tmpdir(), "prek-install-"));
  const cleanup = async (): Promise<void> => {
    await rm(directory, { force: true, recursive: true });
  };
  try {
    const checksumFile = await toolCache.downloadTool(
      `${latest.root}/${asset}.sha256`,
      path.join(directory, `${asset}.sha256`),
    );
    const checksumContents = await readFile(checksumFile, "utf8");
    let archive = cachedArchive(latest.version, asset);

    if (archive === undefined) {
      const downloadedArchive = await toolCache.downloadTool(
        `${latest.root}/${asset}`,
        path.join(directory, asset),
      );
      await verifySha256(downloadedArchive, checksumContents, asset);
      const cacheDirectory = await toolCache.cacheFile(
        downloadedArchive,
        asset,
        "prek-archive",
        latest.version,
        process.arch,
      );
      archive = path.join(cacheDirectory, asset);
    }

    await verifySha256(archive, checksumContents, asset);
    const extracted = await toolCache.extractTar(
      archive,
      path.join(directory, "extract"),
    );
    const binary = path.join(extracted, `prek-${latest.target}`, "prek");
    await verifyExecutable(binary);
    await chmod(binary, 0o755);
    return { binary, cleanup };
  } catch (error) {
    let cleanupFailed = false;
    let cleanupError: unknown;
    try {
      await cleanup();
    } catch (caughtCleanupError) {
      cleanupFailed = true;
      cleanupError = caughtCleanupError;
    }
    if (cleanupFailed) {
      throw new AggregateError(
        [error, cleanupError],
        "prek installation failed and cleanup also failed",
        { cause: error },
      );
    }
    throw error;
  }
}

function cachedArchive(version: string, asset: string): string | undefined {
  const cached = toolCache.find("prek-archive", version, process.arch);
  return cached === "" ? undefined : path.join(cached, asset);
}

async function resolveLatestRelease(releaseTarget: string): Promise<Release> {
  const response = await fetch(LATEST_RELEASE_URL, {
    method: "HEAD",
    redirect: "manual",
  });
  if (![301, 302, 303, 307, 308].includes(response.status)) {
    throw new Error(
      `Latest prek release lookup returned HTTP ${response.status}`,
    );
  }
  const location = response.headers.get("location");
  if (location === null) {
    throw new Error("Latest prek release did not provide a redirect");
  }

  const releaseUrl = new URL(location, LATEST_RELEASE_URL);
  const match = releaseUrl.pathname.match(RELEASE_PATH_PATTERN);
  if (
    releaseUrl.origin !== "https://github.com" ||
    releaseUrl.search !== "" ||
    releaseUrl.hash !== "" ||
    match === null
  ) {
    throw new Error(`Invalid latest prek release URL: ${releaseUrl.href}`);
  }

  const version = `${match[1]}.${match[2]}.${match[3]}`;
  return {
    root: `${RELEASE_ROOT}/v${version}`,
    target: releaseTarget,
    version,
  };
}

async function verifyExecutable(binary: string): Promise<void> {
  const metadata = await lstat(binary);
  if (!metadata.isFile()) {
    throw new Error("Extracted prek executable is not a regular file");
  }
}

async function verifySha256(
  archive: string,
  checksumContents: string,
  asset: string,
): Promise<void> {
  const match = checksumContents.match(/^([a-fA-F0-9]{64})(?:\s+\*?(\S+))?/u);
  if (
    match === null ||
    (match[2] !== undefined && path.basename(match[2]) !== asset)
  ) {
    throw new Error(`Invalid SHA256 checksum file for ${asset}`);
  }
  const digest = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  if (digest !== match[1].toLowerCase()) {
    throw new Error(`SHA256 verification failed for ${asset}`);
  }
}

import * as core from "@actions/core";
import * as toolCache from "@actions/tool-cache";
import { HttpClient } from "@actions/http-client";
import type { HttpClientResponse } from "@actions/http-client";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const LATEST_RELEASE_URL = "https://github.com/j178/prek/releases/latest";
const RELEASE_ROOT = "https://github.com/j178/prek/releases/download";
const RELEASE_PATH_PATTERN =
  /^\/j178\/prek\/releases\/tag\/v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const RELEASE_LOOKUP_ATTEMPTS = 3;
const RELEASE_LOOKUP_DEADLINE_MS = 65_000;
const RELEASE_LOOKUP_BACKOFF_MS = 100;
const RELEASE_LOOKUP_MAX_DELAY_MS = 30_000;
const RELEASE_LOOKUP_TOTAL_DELAY_MS = 30_000;
const RELEASE_LOOKUP_TIMEOUT_MS = 10_000;

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
    const checksumFile = path.join(directory, `${asset}.sha256`);
    await toolCache.downloadTool(
      `${latest.root}/${asset}.sha256`,
      checksumFile,
    );
    const checksumContents = await readFile(checksumFile, "utf8");
    const archive = path.join(directory, asset);
    const cached = cachedArchive(latest.version, asset);
    let useCached = false;

    if (cached !== undefined) {
      try {
        await copyFile(cached, archive);
        await verifySha256(archive, checksumContents, asset);
        useCached = true;
      } catch {
        // The shared cache is optional; recover from its immutable release URL.
      }
    }

    if (!useCached) {
      if (cached !== undefined) {
        await rm(archive, { force: true });
      }
      await toolCache.downloadTool(`${latest.root}/${asset}`, archive);
      await verifySha256(archive, checksumContents, asset);
      if (cached === undefined) {
        try {
          await toolCache.cacheFile(
            archive,
            asset,
            "prek-archive",
            latest.version,
            process.arch,
          );
        } catch (error) {
          core.warning(
            `Failed to cache verified prek archive; continuing without cache: ${errorMessage(error)}`,
          );
        }
      }
    }

    const extracted = await toolCache.extractTar(
      archive,
      path.join(directory, "extract"),
    );
    const binary = path.join(extracted, `prek-${latest.target}`, "prek");
    await verifyExecutable(binary);
    await chmod(binary, 0o755);
    core.info(`Running prek v${latest.version}`);
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
  try {
    const cached = toolCache.find("prek-archive", version, process.arch);
    return cached === "" ? undefined : path.join(cached, asset);
  } catch (error) {
    core.warning(
      `Failed to read prek archive cache; continuing without cache: ${errorMessage(error)}`,
    );
    return undefined;
  }
}

async function resolveLatestRelease(releaseTarget: string): Promise<Release> {
  const client = new HttpClient("prek-autoupdate", [], {
    allowRedirects: false,
    allowRetries: false,
    keepAlive: true,
    socketTimeout: RELEASE_LOOKUP_TIMEOUT_MS,
  });
  const lookup = lookupLatestReleaseResponse(client);
  let deadline: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => {
        reject(
          new Error(
            `Latest prek release lookup exceeded the ${RELEASE_LOOKUP_DEADLINE_MS}ms deadline`,
          ),
        );
      }, RELEASE_LOOKUP_DEADLINE_MS);
    });
    const response = await Promise.race([lookup, timeout]);
    return releaseFromResponse(response, releaseTarget);
  } finally {
    if (deadline !== undefined) {
      clearTimeout(deadline);
    }
    client.dispose();
  }
}

async function lookupLatestReleaseResponse(
  client: HttpClient,
): Promise<HttpClientResponse> {
  let totalDelay = 0;
  for (let attempt = 1; ; attempt += 1) {
    let response: HttpClientResponse;
    try {
      response = await client.head(LATEST_RELEASE_URL);
    } catch (error) {
      if (attempt === RELEASE_LOOKUP_ATTEMPTS) {
        throw error;
      }
      const milliseconds = retryDelay(attempt);
      totalDelay = addRetryDelay(totalDelay, milliseconds);
      await delay(milliseconds);
      continue;
    }
    const status = response.message.statusCode ?? 0;
    if (!isTransientStatus(status) || attempt === RELEASE_LOOKUP_ATTEMPTS) {
      return response;
    }
    await response.readBody();
    const milliseconds = retryDelay(
      attempt,
      response.message.headers["retry-after"],
    );
    totalDelay = addRetryDelay(totalDelay, milliseconds);
    await delay(milliseconds);
  }
}

function releaseFromResponse(
  response: HttpClientResponse,
  releaseTarget: string,
): Release {
  const status = response.message.statusCode ?? 0;
  if (![301, 302, 303, 307, 308].includes(status)) {
    throw new Error(`Latest prek release lookup returned HTTP ${status}`);
  }
  const location = response.message.headers.location;
  if (location === undefined) {
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

function isTransientStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function retryDelay(attempt: number, retryAfter?: string | string[]): number {
  const header = Array.isArray(retryAfter) ? retryAfter[0] : retryAfter;
  let requestedDelay: number | undefined;
  if (header !== undefined) {
    if (/^[0-9]+$/u.test(header)) {
      requestedDelay = Number(header) * 1_000;
    } else {
      const parsedDate = Date.parse(header);
      if (Number.isFinite(parsedDate)) {
        requestedDelay = parsedDate - Date.now();
      }
    }
  }
  const backoff = RELEASE_LOOKUP_BACKOFF_MS * 2 ** (attempt - 1);
  const milliseconds = Math.max(requestedDelay ?? backoff, 0);
  if (milliseconds > RELEASE_LOOKUP_MAX_DELAY_MS) {
    throw new Error(
      `Latest prek release Retry-After exceeds the supported ${RELEASE_LOOKUP_MAX_DELAY_MS}ms delay bound`,
    );
  }
  return milliseconds;
}

function addRetryDelay(total: number, milliseconds: number): number {
  const nextTotal = total + milliseconds;
  if (nextTotal > RELEASE_LOOKUP_TOTAL_DELAY_MS) {
    throw new Error(
      `Latest prek release retries exceed the supported ${RELEASE_LOOKUP_TOTAL_DELAY_MS}ms total delay bound`,
    );
  }
  return nextTotal;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

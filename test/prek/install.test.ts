import * as core from "@actions/core";
import * as toolCache from "@actions/tool-cache";
import { HttpClient } from "@actions/http-client";
import type * as NodeCrypto from "node:crypto";
import type * as NodeFsPromises from "node:fs/promises";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installPrek, targetForArchitecture } from "../../src/prek/install.js";

vi.mock("@actions/tool-cache", () => ({
  cacheFile: vi.fn(),
  downloadTool: vi.fn(),
  extractTar: vi.fn(),
  find: vi.fn(),
}));
vi.mock("@actions/core", () => ({ warning: vi.fn() }));

const httpMocks = vi.hoisted(() => ({
  dispose: vi.fn(),
  head: vi.fn(),
  readBody: vi.fn(async () => ""),
}));
vi.mock("@actions/http-client", () => ({
  HttpClient: vi.fn(function HttpClient() {
    return { dispose: httpMocks.dispose, head: httpMocks.head };
  }),
}));

const filesystemMock = vi.hoisted(() => ({
  cleanupError: undefined as Error | undefined,
  missingCopySource: undefined as string | undefined,
  removalErrorPath: undefined as string | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>();
  return {
    ...actual,
    copyFile: vi.fn(
      async (
        source: Parameters<typeof actual.copyFile>[0],
        destination: Parameters<typeof actual.copyFile>[1],
      ) => {
        if (source.toString() === filesystemMock.missingCopySource) {
          throw new Error("cached archive disappeared");
        }
        await actual.copyFile(source, destination);
      },
    ),
    rm: vi.fn(
      async (
        candidate: Parameters<typeof actual.rm>[0],
        options: Parameters<typeof actual.rm>[1],
      ) => {
        if (candidate.toString() === filesystemMock.removalErrorPath) {
          throw new Error("owned archive removal failed");
        }
        if (
          filesystemMock.cleanupError !== undefined &&
          candidate.toString().includes("prek-install-")
        ) {
          throw filesystemMock.cleanupError;
        }
        await actual.rm(candidate, options);
      },
    ),
  };
});

const ARCHIVE_SHA256 =
  "038f67b69c1d1547e920532f975a0ec1a51453b962f1a2d9148abcb252a6d194";
const RELEASE = {
  asset:
    process.arch === "arm64"
      ? "prek-aarch64-unknown-linux-gnu.tar.gz"
      : "prek-x86_64-unknown-linux-gnu.tar.gz",
  target:
    process.arch === "arm64"
      ? "aarch64-unknown-linux-gnu"
      : "x86_64-unknown-linux-gnu",
  version: "9.8.7",
};
const TEMPORARY_DIRECTORIES: string[] = [];

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeCrypto>();
  return {
    ...actual,
    createHash: vi.fn(() => {
      let contents = "";
      return {
        update(value: Buffer | string) {
          contents = value.toString();
          return this;
        },
        digest(encoding: "hex") {
          if (contents === "valid archive") {
            return ARCHIVE_SHA256;
          }
          return actual.createHash("sha256").update(contents).digest(encoding);
        },
      };
    }),
  };
});

beforeEach(() => {
  filesystemMock.cleanupError = undefined;
  filesystemMock.missingCopySource = undefined;
  filesystemMock.removalErrorPath = undefined;
  vi.clearAllMocks();
  vi.spyOn(global, "setTimeout").mockImplementation(((
    callback: () => void,
    milliseconds?: number,
  ) => {
    if (milliseconds !== 65_000) {
      callback();
    }
    return 0 as unknown as NodeJS.Timeout;
  }) as typeof setTimeout);
  mockLatestRelease();
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  TEMPORARY_DIRECTORIES.push(directory);
  return directory;
}

async function exists(candidate: string): Promise<boolean> {
  return access(candidate).then(
    () => true,
    () => false,
  );
}

function retryTimerDelays(): number[] {
  return vi
    .mocked(setTimeout)
    .mock.calls.map((call) => call[1])
    .filter((milliseconds): milliseconds is number => milliseconds !== 65_000);
}

async function copyDownload(
  source: string,
  destination: string,
): Promise<string> {
  if (await exists(destination)) {
    throw new Error(`download destination already exists: ${destination}`);
  }
  await copyFile(source, destination);
  return destination;
}

function mockLatestRelease(location = releaseUrl()): void {
  httpMocks.head.mockResolvedValue(httpResponse(302, location));
}

function httpResponse(
  statusCode: number,
  location?: string,
  retryAfter?: string,
) {
  return {
    message: {
      headers: {
        ...(location === undefined ? {} : { location }),
        ...(retryAfter === undefined ? {} : { "retry-after": retryAfter }),
      },
      statusCode,
    },
    readBody: httpMocks.readBody,
  };
}

function releaseUrl(): string {
  return `https://github.com/j178/prek/releases/tag/v${RELEASE.version}`;
}

async function arrangeDownload(
  checksumContents: string,
  archiveContents = "valid archive",
): Promise<{
  archive: string;
  cachedArchive: string;
  extractedBinary: string;
}> {
  const downloadDirectory = await temporaryDirectory("prek-assets-test-");
  const extractDirectory = await temporaryDirectory("prek-extract-test-");
  const cacheDirectory = await temporaryDirectory("prek-new-cache-test-");
  const archive = path.join(downloadDirectory, RELEASE.asset);
  const checksum = path.join(downloadDirectory, `${RELEASE.asset}.sha256`);
  const cachedArchive = path.join(cacheDirectory, RELEASE.asset);
  const extractedBinary = path.join(
    extractDirectory,
    `prek-${RELEASE.target}`,
    "prek",
  );
  await mkdir(path.dirname(extractedBinary), { recursive: true });
  await writeFile(archive, archiveContents);
  await writeFile(checksum, checksumContents);
  await writeFile(cachedArchive, archiveContents);
  await writeFile(extractedBinary, "valid binary");
  vi.mocked(toolCache.find).mockReturnValue("");
  vi.mocked(toolCache.downloadTool).mockReset();
  vi.mocked(toolCache.downloadTool)
    .mockImplementationOnce(async (_url, destination) => {
      return copyDownload(checksum, destination!);
    })
    .mockImplementationOnce(async (_url, destination) => {
      return copyDownload(archive, destination!);
    });
  vi.mocked(toolCache.cacheFile).mockResolvedValue(cacheDirectory);
  vi.mocked(toolCache.extractTar).mockResolvedValue(extractDirectory);
  return { archive, cachedArchive, extractedBinary };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(
    TEMPORARY_DIRECTORIES.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("installPrek", () => {
  it.each([
    ["x64", "x86_64-unknown-linux-gnu"],
    ["arm64", "aarch64-unknown-linux-gnu"],
  ] as const)("maps %s to %s", (architecture, expected) => {
    expect(targetForArchitecture(architecture)).toBe(expected);
  });

  it("rejects unsupported architectures", () => {
    expect(() => targetForArchitecture("ia32")).toThrow(
      "Unsupported prek architecture: ia32",
    );
  });

  it("configures a bounded proxy-aware release lookup without redirects", async () => {
    const { extractedBinary } = await arrangeDownload(
      `${ARCHIVE_SHA256}  ${RELEASE.asset}\n`,
    );

    const installation = await installPrek();

    expect(installation.binary).toBe(extractedBinary);
    expect(HttpClient).toHaveBeenCalledWith("prek-autoupdate", [], {
      allowRedirects: false,
      allowRetries: false,
      keepAlive: true,
      socketTimeout: 10_000,
    });
    expect(httpMocks.dispose).toHaveBeenCalledOnce();
    await installation.cleanup();
  });

  it("retries transient latest-release responses within the bound", async () => {
    await arrangeDownload(`${ARCHIVE_SHA256}  ${RELEASE.asset}\n`);
    httpMocks.head
      .mockResolvedValueOnce(httpResponse(429))
      .mockResolvedValueOnce(httpResponse(503))
      .mockResolvedValueOnce(httpResponse(302, releaseUrl()));

    const installation = await installPrek();

    expect(httpMocks.head).toHaveBeenCalledTimes(3);
    expect(httpMocks.readBody).toHaveBeenCalledTimes(2);
    expect(retryTimerDelays()).toEqual([100, 200]);
    expect(httpMocks.dispose).toHaveBeenCalledOnce();
    await installation.cleanup();
  });

  it("recovers from a transient transport rejection", async () => {
    await arrangeDownload(`${ARCHIVE_SHA256}  ${RELEASE.asset}\n`);
    httpMocks.head
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(httpResponse(302, releaseUrl()));

    const installation = await installPrek();

    expect(httpMocks.head).toHaveBeenCalledTimes(2);
    expect(retryTimerDelays()).toEqual([100]);
    await installation.cleanup();
  });

  it("honors Retry-After within the explicit delay budget", async () => {
    await arrangeDownload(`${ARCHIVE_SHA256}  ${RELEASE.asset}\n`);
    httpMocks.head
      .mockResolvedValueOnce(httpResponse(429, undefined, "30"))
      .mockResolvedValueOnce(httpResponse(302, releaseUrl()));

    const installation = await installPrek();

    expect(retryTimerDelays()).toEqual([30_000]);
    await installation.cleanup();
  });

  it("rejects Retry-After beyond the supported delay budget", async () => {
    httpMocks.head.mockResolvedValue(httpResponse(429, undefined, "31"));

    await expect(installPrek()).rejects.toThrow(
      "Retry-After exceeds the supported 30000ms delay bound",
    );
    expect(httpMocks.head).toHaveBeenCalledOnce();
    expect(retryTimerDelays()).toEqual([]);
  });

  it("propagates a terminal transient status after bounded retries", async () => {
    httpMocks.head.mockResolvedValue(httpResponse(500));

    await expect(installPrek()).rejects.toThrow(
      "Latest prek release lookup returned HTTP 500",
    );
    expect(httpMocks.head).toHaveBeenCalledTimes(3);
    expect(httpMocks.dispose).toHaveBeenCalledOnce();
  });

  it("propagates transport failure after the retry bound", async () => {
    const timeout = new Error("socket timeout");
    httpMocks.head.mockRejectedValue(timeout);

    await expect(installPrek()).rejects.toBe(timeout);
    expect(httpMocks.head).toHaveBeenCalledTimes(3);
    expect(retryTimerDelays()).toEqual([100, 200]);
    expect(httpMocks.dispose).toHaveBeenCalledOnce();
  });

  it("enforces an absolute deadline on a never-settling lookup", async () => {
    httpMocks.head.mockReturnValue(new Promise(() => undefined));

    const installation = installPrek();
    const deadline = vi
      .mocked(setTimeout)
      .mock.calls.find((call) => call[1] === 65_000);
    expect(deadline).toBeDefined();
    (deadline![0] as () => void)();

    await expect(installation).rejects.toThrow(
      "Latest prek release lookup exceeded the 65000ms deadline",
    );
    expect(httpMocks.dispose).toHaveBeenCalledOnce();
  });

  it("recovers from a tampered cached archive with a verified download", async () => {
    const { extractedBinary } = await arrangeDownload(
      `${ARCHIVE_SHA256}  ${RELEASE.asset}\n`,
    );
    const cacheDirectory = await temporaryDirectory("prek-cache-test-");
    await writeFile(path.join(cacheDirectory, RELEASE.asset), "tampered");
    vi.mocked(toolCache.find).mockReturnValue(cacheDirectory);

    const installation = await installPrek();

    expect(installation.binary).toBe(extractedBinary);
    expect(toolCache.downloadTool).toHaveBeenCalledTimes(2);
    expect(toolCache.cacheFile).not.toHaveBeenCalled();
    await installation.cleanup();
  });

  it("warns and treats cache discovery failure as a miss", async () => {
    const { extractedBinary } = await arrangeDownload(
      `${ARCHIVE_SHA256}  ${RELEASE.asset}\n`,
    );
    vi.mocked(toolCache.find).mockImplementation(() => {
      throw new Error("cache discovery failed");
    });

    const installation = await installPrek();

    expect(installation.binary).toBe(extractedBinary);
    expect(core.warning).toHaveBeenCalledWith(
      "Failed to read prek archive cache; continuing without cache: cache discovery failed",
    );
    expect(toolCache.cacheFile).toHaveBeenCalledOnce();
    await installation.cleanup();
  });

  it("does not ignore failure to remove a rejected cached copy", async () => {
    const { archive } = await arrangeDownload(
      `${ARCHIVE_SHA256}  ${RELEASE.asset}\n`,
    );
    const cacheDirectory = await temporaryDirectory("prek-cache-test-");
    await writeFile(path.join(cacheDirectory, RELEASE.asset), "tampered");
    vi.mocked(toolCache.find).mockReturnValue(cacheDirectory);
    vi.mocked(toolCache.downloadTool)
      .mockReset()
      .mockImplementationOnce(async (_url, destination) => {
        const result = await copyDownload(`${archive}.sha256`, destination!);
        filesystemMock.removalErrorPath = path.join(
          path.dirname(destination!),
          RELEASE.asset,
        );
        return result;
      })
      .mockImplementationOnce(async (_url, destination) => {
        return copyDownload(archive, destination!);
      });

    await expect(installPrek()).rejects.toThrow("owned archive removal failed");
    expect(toolCache.downloadTool).toHaveBeenCalledOnce();
  });

  it.each(["missing", "racing"])(
    "recovers from a %s cached archive",
    async (failure) => {
      const { cachedArchive, extractedBinary } = await arrangeDownload(
        `${ARCHIVE_SHA256}  ${RELEASE.asset}\n`,
      );
      const cacheDirectory = path.dirname(cachedArchive);
      if (failure === "missing") {
        await rm(cachedArchive);
        vi.mocked(toolCache.find).mockReturnValue(cacheDirectory);
      } else {
        vi.mocked(toolCache.find).mockImplementation(() => {
          filesystemMock.missingCopySource = cachedArchive;
          return cacheDirectory;
        });
      }

      const installation = await installPrek();

      expect(installation.binary).toBe(extractedBinary);
      expect(toolCache.downloadTool).toHaveBeenCalledTimes(2);
      expect(toolCache.cacheFile).not.toHaveBeenCalled();
      await installation.cleanup();
    },
  );

  it("resolves, downloads, verifies, extracts, and caches the latest release", async () => {
    const { extractedBinary } = await arrangeDownload(
      `${ARCHIVE_SHA256}  ${RELEASE.asset}\n`,
    );

    const installation = await installPrek();
    expect(installation.binary).toBe(extractedBinary);
    expect(httpMocks.head).toHaveBeenCalledWith(
      "https://github.com/j178/prek/releases/latest",
    );
    expect(toolCache.downloadTool).toHaveBeenNthCalledWith(
      1,
      `https://github.com/j178/prek/releases/download/v${RELEASE.version}/${RELEASE.asset}.sha256`,
      expect.stringContaining(`prek-install-`),
    );
    expect(toolCache.downloadTool).toHaveBeenNthCalledWith(
      2,
      `https://github.com/j178/prek/releases/download/v${RELEASE.version}/${RELEASE.asset}`,
      expect.stringContaining(`prek-install-`),
    );
    const checksumDestination = vi.mocked(toolCache.downloadTool).mock
      .calls[0]![1]!;
    const archiveDestination = vi.mocked(toolCache.downloadTool).mock
      .calls[1]![1]!;
    expect(toolCache.cacheFile).toHaveBeenCalledWith(
      archiveDestination,
      RELEASE.asset,
      "prek-archive",
      RELEASE.version,
      process.arch,
    );
    expect(toolCache.extractTar).toHaveBeenCalledWith(
      archiveDestination,
      expect.stringContaining("prek-install-"),
    );
    const extractionDirectory = vi.mocked(toolCache.extractTar).mock
      .calls[0]![1]!;
    const installationRoot = path.dirname(checksumDestination);
    expect(path.dirname(archiveDestination)).toBe(installationRoot);
    expect(path.dirname(extractionDirectory)).toBe(installationRoot);
    await installation.cleanup();
    await installation.cleanup();
    expect(await exists(installationRoot)).toBe(false);
  });

  it("uses the same owned root with a cached archive", async () => {
    const { archive, extractedBinary } = await arrangeDownload(
      `${ARCHIVE_SHA256}  ${RELEASE.asset}\n`,
    );
    const cacheDirectory = path.dirname(archive);
    vi.mocked(toolCache.find).mockReturnValue(cacheDirectory);
    const checksum = path.join(cacheDirectory, `${RELEASE.asset}.sha256`);
    await writeFile(checksum, `${ARCHIVE_SHA256}  ${RELEASE.asset}\n`);
    vi.mocked(toolCache.downloadTool)
      .mockReset()
      .mockImplementationOnce(async (_url, destination) => {
        return copyDownload(checksum, destination!);
      });
    vi.mocked(toolCache.extractTar).mockImplementationOnce(
      async (ownedArchive, destination) => {
        await writeFile(archive, "replaced shared cache");
        expect(await readFile(ownedArchive, "utf8")).toBe("valid archive");
        return destination === undefined
          ? path.dirname(extractedBinary)
          : path.dirname(path.dirname(extractedBinary));
      },
    );

    const installation = await installPrek();
    expect(installation.binary).toBe(extractedBinary);
    expect(toolCache.downloadTool).toHaveBeenCalledOnce();
    const destination = vi.mocked(toolCache.downloadTool).mock.calls[0]![1]!;
    const extraction = vi.mocked(toolCache.extractTar).mock.calls[0]![1]!;
    expect(path.dirname(extraction)).toBe(path.dirname(destination));
    await installation.cleanup();
    expect(await exists(path.dirname(destination))).toBe(false);
  });

  it.each([
    "checksum download",
    "checksum read",
    "archive download",
    "extraction",
  ])("removes its owned root after a %s failure", async (stage) => {
    const arranged = await arrangeDownload(
      `${ARCHIVE_SHA256}  ${RELEASE.asset}\n`,
    );
    if (stage === "checksum download") {
      vi.mocked(toolCache.downloadTool)
        .mockReset()
        .mockRejectedValueOnce(new Error("checksum download failed"));
    } else if (stage === "checksum read") {
      vi.mocked(toolCache.downloadTool)
        .mockReset()
        .mockResolvedValueOnce(path.join(arranged.archive, "missing"));
    } else if (stage === "archive download") {
      vi.mocked(toolCache.downloadTool)
        .mockReset()
        .mockImplementationOnce(async (_url, destination) => {
          if (await exists(destination!)) {
            throw new Error(
              `download destination already exists: ${destination}`,
            );
          }
          await writeFile(
            destination!,
            `${ARCHIVE_SHA256}  ${RELEASE.asset}\n`,
          );
          return destination!;
        })
        .mockRejectedValueOnce(new Error("archive download failed"));
    } else {
      vi.mocked(toolCache.extractTar).mockRejectedValueOnce(
        new Error("extraction failed"),
      );
    }

    await expect(installPrek()).rejects.toThrow();
    const destination = vi.mocked(toolCache.downloadTool).mock.calls[0]![1]!;
    expect(await exists(path.dirname(destination))).toBe(false);
  });

  it("warns and continues when publishing the verified cache fails", async () => {
    const { extractedBinary } = await arrangeDownload(
      `${ARCHIVE_SHA256}  ${RELEASE.asset}\n`,
    );
    vi.mocked(toolCache.cacheFile).mockRejectedValueOnce(
      new Error("cache failed"),
    );

    const installation = await installPrek();

    expect(installation.binary).toBe(extractedBinary);
    expect(core.warning).toHaveBeenCalledWith(
      "Failed to cache verified prek archive; continuing without cache: cache failed",
    );
    await installation.cleanup();
  });

  it.each([
    ["not a checksum", "Invalid SHA256 checksum file"],
    [`${"0".repeat(64)}  ${RELEASE.asset}\n`, "SHA256 verification failed"],
  ])(
    "rejects an invalid downloaded checksum: %s",
    async (checksum, message) => {
      await arrangeDownload(checksum);

      await expect(installPrek()).rejects.toThrow(message);
      const destination = vi.mocked(toolCache.downloadTool).mock.calls[0]![1]!;
      expect(await exists(path.dirname(destination))).toBe(false);
      expect(toolCache.extractTar).not.toHaveBeenCalled();
      expect(toolCache.cacheFile).not.toHaveBeenCalled();
    },
  );

  it("rejects a freshly downloaded archive that does not match its checksum", async () => {
    await arrangeDownload(
      `${ARCHIVE_SHA256}  ${RELEASE.asset}\n`,
      "tampered archive",
    );

    await expect(installPrek()).rejects.toThrow(
      `SHA256 verification failed for ${RELEASE.asset}`,
    );
    const destination = vi.mocked(toolCache.downloadTool).mock.calls[0]![1]!;
    expect(await exists(path.dirname(destination))).toBe(false);
    expect(toolCache.extractTar).not.toHaveBeenCalled();
    expect(toolCache.cacheFile).not.toHaveBeenCalled();
  });

  it.each([
    ["https://example.com/j178/prek/releases/tag/v9.8.7"],
    ["https://github.com/j178/prek/releases/tag/latest"],
    ["https://github.com/other/prek/releases/tag/v9.8.7"],
    ["https://github.com/j178/prek/releases/tag/v9.8.7?asset=other"],
  ])("rejects an invalid latest-release redirect: %s", async (location) => {
    mockLatestRelease(location);

    await expect(installPrek()).rejects.toThrow(
      "Invalid latest prek release URL",
    );
    expect(toolCache.downloadTool).not.toHaveBeenCalled();
  });

  it("rejects a latest-release response without a redirect", async () => {
    httpMocks.head.mockResolvedValue(httpResponse(200));

    await expect(installPrek()).rejects.toThrow(
      "Latest prek release lookup returned HTTP 200",
    );
    expect(toolCache.downloadTool).not.toHaveBeenCalled();
  });

  it("rejects a redirect without a release location", async () => {
    httpMocks.head.mockResolvedValue(httpResponse(302));

    await expect(installPrek()).rejects.toThrow(
      "Latest prek release did not provide a redirect",
    );
    expect(toolCache.downloadTool).not.toHaveBeenCalled();
  });

  it("rejects a symlink extracted in place of the executable", async () => {
    const { extractedBinary } = await arrangeDownload(
      `${ARCHIVE_SHA256}  ${RELEASE.asset}\n`,
    );
    await rm(extractedBinary);
    await symlink("/usr/bin/true", extractedBinary);

    await expect(installPrek()).rejects.toThrow(
      "Extracted prek executable is not a regular file",
    );
    const checksumDestination = vi.mocked(toolCache.downloadTool).mock
      .calls[0]![1]!;
    expect(await exists(path.dirname(checksumDestination))).toBe(false);
  });

  it("retains installation and cleanup failures together", async () => {
    const { extractedBinary } = await arrangeDownload(
      `${ARCHIVE_SHA256}  ${RELEASE.asset}\n`,
    );
    await rm(extractedBinary);
    await symlink("/usr/bin/true", extractedBinary);
    const cleanupError = new Error("cleanup failed");
    filesystemMock.cleanupError = cleanupError;

    const error = await installPrek().catch((caught: unknown) => caught);
    filesystemMock.cleanupError = undefined;

    expect(error).toMatchObject({
      message: "prek installation failed and cleanup also failed",
    });
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({
        message: "Extracted prek executable is not a regular file",
      }),
      cleanupError,
    ]);
  });
});

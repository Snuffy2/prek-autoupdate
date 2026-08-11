import * as toolCache from "@actions/tool-cache";
import type * as NodeCrypto from "node:crypto";
import type * as NodeFsPromises from "node:fs/promises";
import {
  access,
  mkdir,
  mkdtemp,
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

const filesystemMock = vi.hoisted(() => ({
  cleanupError: undefined as Error | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>();
  return {
    ...actual,
    rm: vi.fn(
      async (
        candidate: Parameters<typeof actual.rm>[0],
        options: Parameters<typeof actual.rm>[1],
      ) => {
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
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn());
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

function mockLatestRelease(location = releaseUrl()): void {
  vi.mocked(fetch).mockResolvedValue(
    new Response(null, {
      status: 302,
      headers: { location },
    }),
  );
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
  vi.mocked(toolCache.downloadTool)
    .mockResolvedValueOnce(checksum)
    .mockResolvedValueOnce(archive);
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

  it("rejects a tampered cached archive", async () => {
    const downloadDirectory = await temporaryDirectory("prek-checksum-test-");
    const checksum = path.join(downloadDirectory, `${RELEASE.asset}.sha256`);
    await writeFile(checksum, `${ARCHIVE_SHA256}  ${RELEASE.asset}\n`);
    const cacheDirectory = await temporaryDirectory("prek-cache-test-");
    await writeFile(path.join(cacheDirectory, RELEASE.asset), "tampered");
    vi.mocked(toolCache.find).mockReturnValue(cacheDirectory);
    vi.mocked(toolCache.downloadTool).mockResolvedValue(checksum);

    await expect(installPrek()).rejects.toThrow(
      `SHA256 verification failed for ${RELEASE.asset}`,
    );
    expect(toolCache.downloadTool).toHaveBeenCalledOnce();
    expect(toolCache.extractTar).not.toHaveBeenCalled();
  });

  it("resolves, downloads, verifies, extracts, and caches the latest release", async () => {
    const { archive, cachedArchive, extractedBinary } = await arrangeDownload(
      `${ARCHIVE_SHA256}  ${RELEASE.asset}\n`,
    );

    const installation = await installPrek();
    expect(installation.binary).toBe(extractedBinary);
    expect(fetch).toHaveBeenCalledWith(
      "https://github.com/j178/prek/releases/latest",
      { method: "HEAD", redirect: "manual" },
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
    expect(toolCache.cacheFile).toHaveBeenCalledWith(
      archive,
      RELEASE.asset,
      "prek-archive",
      RELEASE.version,
      process.arch,
    );
    expect(toolCache.extractTar).toHaveBeenCalledWith(
      cachedArchive,
      expect.stringContaining("prek-install-"),
    );
    const checksumDestination = vi.mocked(toolCache.downloadTool).mock
      .calls[0]![1]!;
    const archiveDestination = vi.mocked(toolCache.downloadTool).mock
      .calls[1]![1]!;
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
    vi.mocked(toolCache.downloadTool)
      .mockReset()
      .mockResolvedValueOnce(
        path.join(cacheDirectory, `${RELEASE.asset}.sha256`),
      );
    await writeFile(
      path.join(cacheDirectory, `${RELEASE.asset}.sha256`),
      `${ARCHIVE_SHA256}  ${RELEASE.asset}\n`,
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
    "cache",
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
        .mockResolvedValueOnce(
          path.join(path.dirname(arranged.archive), `${RELEASE.asset}.sha256`),
        )
        .mockRejectedValueOnce(new Error("archive download failed"));
    } else if (stage === "cache") {
      vi.mocked(toolCache.cacheFile).mockRejectedValueOnce(
        new Error("cache failed"),
      );
    } else {
      vi.mocked(toolCache.extractTar).mockRejectedValueOnce(
        new Error("extraction failed"),
      );
    }

    await expect(installPrek()).rejects.toThrow();
    const destination = vi.mocked(toolCache.downloadTool).mock.calls[0]![1]!;
    expect(await exists(path.dirname(destination))).toBe(false);
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
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 200 }));

    await expect(installPrek()).rejects.toThrow(
      "Latest prek release lookup returned HTTP 200",
    );
    expect(toolCache.downloadTool).not.toHaveBeenCalled();
  });

  it("rejects a redirect without a release location", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 302 }));

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

import * as toolCache from "@actions/tool-cache";
import type * as NodeCrypto from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installPrek } from "../../src/prek/install.js";

vi.mock("@actions/tool-cache", () => ({
  cacheDir: vi.fn(),
  downloadTool: vi.fn(),
  extractTar: vi.fn(),
  find: vi.fn(),
}));

const RELEASE =
  process.arch === "arm64"
    ? {
        archiveSha256:
          "22edbb9353ca948b8260a904abedc352d0087944170785adab8d1fa1025534e7",
        binarySha256:
          "c6388688a4e98ffaff076e94ce9b65fda377101219207e76099cef0b0ce29482",
        target: "aarch64-unknown-linux-gnu",
      }
    : {
        archiveSha256:
          "038f67b69c1d1547e920532f975a0ec1a51453b962f1a2d9148abcb252a6d194",
        binarySha256:
          "c8ff33f4745f31fd770adfce904bb09108365542fd07580f3c2b1f783879495a",
        target: "x86_64-unknown-linux-gnu",
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
            return process.arch === "arm64"
              ? "22edbb9353ca948b8260a904abedc352d0087944170785adab8d1fa1025534e7"
              : "038f67b69c1d1547e920532f975a0ec1a51453b962f1a2d9148abcb252a6d194";
          }
          if (contents === "valid binary") {
            return process.arch === "arm64"
              ? "c6388688a4e98ffaff076e94ce9b65fda377101219207e76099cef0b0ce29482"
              : "c8ff33f4745f31fd770adfce904bb09108365542fd07580f3c2b1f783879495a";
          }
          return actual.createHash("sha256").update(contents).digest(encoding);
        },
      };
    }),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  TEMPORARY_DIRECTORIES.push(directory);
  return directory;
}

async function arrangeDownload(
  checksumContents: string,
  archiveContents = "valid archive",
): Promise<{
  archive: string;
  cachedBinary: string;
  extractedBinary: string;
}> {
  const downloadDirectory = await temporaryDirectory("prek-assets-test-");
  const extractDirectory = await temporaryDirectory("prek-extract-test-");
  const cacheDirectory = await temporaryDirectory("prek-new-cache-test-");
  const archive = path.join(downloadDirectory, "prek.tar.gz");
  const checksum = path.join(downloadDirectory, "prek.tar.gz.sha256");
  const extractedBinary = path.join(
    extractDirectory,
    `prek-${RELEASE.target}`,
    "prek",
  );
  const cachedBinary = path.join(cacheDirectory, "prek");
  await mkdir(path.dirname(extractedBinary), { recursive: true });
  await writeFile(archive, archiveContents);
  await writeFile(checksum, checksumContents);
  await writeFile(extractedBinary, "valid binary");
  await writeFile(cachedBinary, "valid binary");
  vi.mocked(toolCache.find).mockReturnValue("");
  vi.mocked(toolCache.downloadTool)
    .mockResolvedValueOnce(archive)
    .mockResolvedValueOnce(checksum);
  vi.mocked(toolCache.extractTar).mockResolvedValue(extractDirectory);
  vi.mocked(toolCache.cacheDir).mockResolvedValue(cacheDirectory);
  return { archive, cachedBinary, extractedBinary };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    TEMPORARY_DIRECTORIES.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("installPrek", () => {
  it("rejects a tampered cached binary", async () => {
    const cacheDirectory = await temporaryDirectory("prek-cache-test-");
    await writeFile(path.join(cacheDirectory, "prek"), "tampered");
    vi.mocked(toolCache.find).mockReturnValue(cacheDirectory);

    await expect(installPrek()).rejects.toThrow(
      "SHA256 verification failed for cached prek binary",
    );
    expect(toolCache.downloadTool).not.toHaveBeenCalled();
  });

  it("downloads, verifies, extracts, and caches the pinned release", async () => {
    const { archive, cachedBinary, extractedBinary } = await arrangeDownload(
      `${RELEASE.archiveSha256}  prek-${RELEASE.target}.tar.gz\n`,
    );

    await expect(installPrek()).resolves.toBe(cachedBinary);
    expect(toolCache.downloadTool).toHaveBeenNthCalledWith(
      1,
      `https://github.com/j178/prek/releases/download/v0.4.11/prek-${RELEASE.target}.tar.gz`,
    );
    expect(toolCache.extractTar).toHaveBeenCalledWith(
      archive,
      expect.stringContaining("prek-download-"),
    );
    expect(toolCache.cacheDir).toHaveBeenCalledWith(
      path.dirname(extractedBinary),
      "prek",
      "0.4.11",
      process.arch,
    );
  });

  it.each([
    ["not a checksum", "Invalid SHA256 checksum file"],
    [
      `${"0".repeat(64)}  prek-${RELEASE.target}.tar.gz\n`,
      "SHA256 verification failed",
    ],
  ])(
    "rejects an invalid downloaded checksum: %s",
    async (checksum, message) => {
      await arrangeDownload(checksum);

      await expect(installPrek()).rejects.toThrow(message);
      expect(toolCache.extractTar).not.toHaveBeenCalled();
      expect(toolCache.cacheDir).not.toHaveBeenCalled();
    },
  );

  it("rejects a freshly downloaded archive that does not match its pinned checksum", async () => {
    await arrangeDownload(
      `${RELEASE.archiveSha256}  prek-${RELEASE.target}.tar.gz\n`,
      "tampered archive",
    );

    await expect(installPrek()).rejects.toThrow(
      `SHA256 verification failed for prek-${RELEASE.target}.tar.gz`,
    );
    expect(toolCache.extractTar).not.toHaveBeenCalled();
    expect(toolCache.cacheDir).not.toHaveBeenCalled();
  });
});

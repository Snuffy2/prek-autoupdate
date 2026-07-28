import * as toolCache from "@actions/tool-cache";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { installPrek } from "../../src/prek/install.js";

vi.mock("@actions/tool-cache", () => ({
  cacheDir: vi.fn(),
  downloadTool: vi.fn(),
  extractTar: vi.fn(),
  find: vi.fn(),
}));

const TEMPORARY_DIRECTORIES: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    TEMPORARY_DIRECTORIES.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("installPrek", () => {
  it("rejects a tampered cached x64 binary", async () => {
    const cacheDirectory = await mkdtemp(
      path.join(tmpdir(), "prek-cache-test-"),
    );
    TEMPORARY_DIRECTORIES.push(cacheDirectory);
    await writeFile(path.join(cacheDirectory, "prek"), "tampered");
    vi.mocked(toolCache.find).mockReturnValue(cacheDirectory);

    await expect(installPrek()).rejects.toThrow(
      "SHA256 verification failed for cached prek binary",
    );
    expect(toolCache.downloadTool).not.toHaveBeenCalled();
  });
});

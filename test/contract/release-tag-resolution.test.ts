import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

interface ResolutionOptions {
  readonly bump?: string;
  readonly explicitTag?: string;
  readonly prerelease?: boolean;
  readonly persistedTag?: string;
  readonly requirePersistedTag?: boolean;
  readonly releases?: Array<{
    readonly draft: boolean;
    readonly prerelease: boolean;
    readonly published_at: string | null;
    readonly tag_name: string;
  }>;
}

function resolveReleaseTag(options: ResolutionOptions): {
  readonly ghCalled: boolean;
  readonly persistedTag?: string;
  readonly releaseTag: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "prek-release-tag-"));
  const callsPath = join(directory, "calls");
  const outputPath = join(directory, "output");
  const persistedTagPath = join(directory, "persisted", "release-tag");
  const ghPath = join(directory, "gh");
  writeFileSync(
    ghPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$CALLS_PATH"
printf '%s\n' "$RELEASES_JSON"
`,
  );
  chmodSync(ghPath, 0o755);
  mkdirSync(join(directory, "persisted"), { recursive: true });
  if (options.persistedTag !== undefined) {
    writeFileSync(persistedTagPath, `${options.persistedTag}\n`);
  }
  try {
    try {
      execFileSync(
        process.execPath,
        [resolve(".github/scripts/resolve-release-tag.mjs")],
        {
          cwd: resolve("."),
          env: {
            ...process.env,
            BUMP_TYPE: options.bump ?? "none",
            CALLS_PATH: callsPath,
            EXPLICIT_TAG: options.explicitTag ?? "",
            GH_TOKEN: "token-sentinel",
            GITHUB_OUTPUT: outputPath,
            GITHUB_REPOSITORY: "owner/repository",
            IS_PRERELEASE: String(options.prerelease ?? false),
            PATH: `${directory}:${process.env.PATH}`,
            PERSISTED_TAG_PATH: persistedTagPath,
            REQUIRE_PERSISTED_TAG: String(options.requirePersistedTag ?? false),
            RELEASES_JSON: JSON.stringify([options.releases ?? []]),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (error) {
      const stderr = (error as { stderr?: Buffer | string }).stderr;
      throw new Error(stderr?.toString().trim() || "tag resolution failed", {
        cause: error,
      });
    }
    return {
      ghCalled:
        readFileSync(callsPath, { encoding: "utf8", flag: "a+" }) !== "",
      ...(readFileSync(persistedTagPath, {
        encoding: "utf8",
        flag: "a+",
      }).trim()
        ? { persistedTag: readFileSync(persistedTagPath, "utf8").trim() }
        : {}),
      releaseTag: readFileSync(outputPath, "utf8")
        .trim()
        .replace(/^release-tag=/u, ""),
    };
  } finally {
    rmSync(directory, { recursive: true });
  }
}

describe("release tag resolution", () => {
  it("prefers an explicit tag over the bump selection", () => {
    expect(resolveReleaseTag({ bump: "major", explicitTag: "v4.5.6" })).toEqual(
      { ghCalled: false, releaseTag: "v4.5.6" },
    );
  });

  it("persists and recovers the automatic tag without bumping again", () => {
    const firstAttempt = resolveReleaseTag({
      bump: "patch",
      releases: [
        {
          draft: false,
          prerelease: false,
          published_at: "2026-01-01T00:00:00Z",
          tag_name: "v2.4.9",
        },
      ],
    });
    expect(firstAttempt).toEqual({
      ghCalled: true,
      persistedTag: "v2.4.10",
      releaseTag: "v2.4.10",
    });

    expect(
      resolveReleaseTag({
        bump: "patch",
        persistedTag: firstAttempt.persistedTag,
        requirePersistedTag: true,
      }),
    ).toEqual({
      ghCalled: false,
      persistedTag: "v2.4.10",
      releaseTag: "v2.4.10",
    });
  });

  it("fails safely when an automatic rerun has no persisted tag", () => {
    expect(() =>
      resolveReleaseTag({
        bump: "patch",
        releases: [
          {
            draft: false,
            prerelease: false,
            published_at: "2026-01-01T00:00:00Z",
            tag_name: "v2.4.9",
          },
        ],
        requirePersistedTag: true,
      }),
    ).toThrow(/persisted automatic release tag is missing/iu);
  });

  it("fails safely when an automatic rerun has a corrupt persisted tag", () => {
    expect(() =>
      resolveReleaseTag({
        bump: "patch",
        persistedTag: "not-a-release-tag",
        releases: [
          {
            draft: false,
            prerelease: false,
            published_at: "2026-01-01T00:00:00Z",
            tag_name: "v2.4.9",
          },
        ],
        requirePersistedTag: true,
      }),
    ).toThrow(/persisted automatic release tag is invalid/iu);
  });

  it("keeps explicit tags ahead of persisted automatic state", () => {
    expect(
      resolveReleaseTag({
        bump: "major",
        explicitTag: "v4.5.6",
        persistedTag: "v2.4.10",
        requirePersistedTag: true,
      }),
    ).toEqual({
      ghCalled: false,
      persistedTag: "v2.4.10",
      releaseTag: "v4.5.6",
    });
  });

  it("requires an explicit tag when publishing a prerelease", () => {
    expect(() =>
      resolveReleaseTag({ bump: "minor", prerelease: true }),
    ).toThrow(/prereleases require an explicit release tag/iu);
    expect(
      resolveReleaseTag({
        bump: "major",
        explicitTag: "v4.0.0-beta.1",
        prerelease: true,
      }),
    ).toEqual({ ghCalled: false, releaseTag: "v4.0.0-beta.1" });
  });

  it.each([
    ["patch", "v2.4.10"],
    ["minor", "v2.5.0"],
    ["major", "v3.0.0"],
  ] as const)(
    "applies a %s bump to the highest stable release",
    (bump, expected) => {
      const result = resolveReleaseTag({
        bump,
        releases: [
          {
            draft: false,
            prerelease: false,
            published_at: "2026-01-01T00:00:00Z",
            tag_name: "v2.3.12",
          },
          {
            draft: false,
            prerelease: false,
            published_at: "2026-02-01T00:00:00Z",
            tag_name: "v2.4.9",
          },
          {
            draft: false,
            prerelease: true,
            published_at: "2026-03-01T00:00:00Z",
            tag_name: "v9.0.0-beta.1",
          },
          {
            draft: true,
            prerelease: false,
            published_at: null,
            tag_name: "v8.0.0",
          },
        ],
      });

      expect(result).toMatchObject({ ghCalled: true, releaseTag: expected });
    },
  );

  it("requires either an explicit tag or a bump selection", () => {
    expect(() => resolveReleaseTag({})).toThrow(
      /explicit release tag or select a version bump/iu,
    );
  });

  it("fails when no published stable semantic release can be bumped", () => {
    expect(() =>
      resolveReleaseTag({
        bump: "patch",
        releases: [
          {
            draft: false,
            prerelease: true,
            published_at: "2026-01-01T00:00:00Z",
            tag_name: "v3.0.0-beta.1",
          },
        ],
      }),
    ).toThrow(/no published stable semantic release/iu);
  });
});

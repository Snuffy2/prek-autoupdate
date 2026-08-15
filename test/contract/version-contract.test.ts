import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { versionBanner } from "../../src/version.js";

interface PackageMetadata {
  readonly version: string;
}

describe("release version", () => {
  it("keeps the bundled runtime version aligned with package metadata", () => {
    const packageMetadata = JSON.parse(
      readFileSync("package.json", "utf8"),
    ) as PackageMetadata;

    expect(versionBanner()).toBe(
      `prek-autoupdate version v${packageMetadata.version}`,
    );
  });
});

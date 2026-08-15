import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ACTION_VERSION } from "../../src/version.js";

interface PackageMetadata {
  readonly version: string;
}

describe("release version", () => {
  it("keeps the bundled runtime version aligned with package metadata", () => {
    const packageMetadata = JSON.parse(
      readFileSync("package.json", "utf8"),
    ) as PackageMetadata;

    expect(ACTION_VERSION).toBe(packageMetadata.version);
  });
});

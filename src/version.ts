import { readFileSync } from "node:fs";

interface PackageMetadata {
  readonly version: string;
}

/** Return the version banner shown at the start of each action run. */
export function versionBanner(): string {
  // Resolve the action's metadata, independent of the caller's working directory.
  // Reading at runtime keeps release-only version bumps out of the bundle.
  const packageMetadata = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as PackageMetadata;
  return `prek-autoupdate version v${packageMetadata.version}`;
}

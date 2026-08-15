import packageMetadata from "../package.json" with { type: "json" };

/** Return the version banner shown at the start of each action run. */
export function versionBanner(): string {
  return `prek-autoupdate version v${packageMetadata.version}`;
}

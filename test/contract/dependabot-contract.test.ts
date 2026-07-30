import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface DependabotIgnoreRule {
  readonly "dependency-name": string;
  readonly "update-types"?: readonly string[];
  readonly "versions"?: readonly string[];
}

interface DependabotConfiguration {
  readonly updates: readonly {
    readonly "package-ecosystem": string;
    readonly "ignore"?: readonly DependabotIgnoreRule[];
  }[];
}

const configuration = parse(
  readFileSync(".github/dependabot.yml", "utf8"),
) as DependabotConfiguration;

describe("Dependabot configuration", () => {
  it("keeps bundled runtime dependency updates in maintainer-controlled PRs", () => {
    const npm = configuration.updates.find(
      (update) => update["package-ecosystem"] === "npm",
    );
    const actions = npm?.ignore?.find(
      (rule) => rule["dependency-name"] === "@actions/*",
    );

    expect(actions?.["update-types"]).toEqual([
      "version-update:semver-patch",
      "version-update:semver-minor",
      "version-update:semver-major",
    ]);
  });

  it("does not propose unsupported TypeScript 7 updates", () => {
    const npm = configuration.updates.find(
      (update) => update["package-ecosystem"] === "npm",
    );
    const typescript = npm?.ignore?.find(
      (rule) => rule["dependency-name"] === "typescript",
    );

    expect(typescript?.versions).toEqual([">=7.0.0"]);
  });
});

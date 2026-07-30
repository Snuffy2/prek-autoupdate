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
    readonly "groups"?: Readonly<
      Record<
        string,
        {
          readonly "dependency-type"?: string;
          readonly "patterns"?: readonly string[];
          readonly "update-types"?: readonly string[];
        }
      >
    >;
    readonly "ignore"?: readonly DependabotIgnoreRule[];
    readonly "schedule": {
      readonly interval: string;
    };
  }[];
}

const configuration = parse(
  readFileSync(".github/dependabot.yml", "utf8"),
) as DependabotConfiguration;

describe("Dependabot configuration", () => {
  it("allows version update pull requests for bundled runtime dependencies", () => {
    const npm = configuration.updates.find(
      (update) => update["package-ecosystem"] === "npm",
    );

    expect(
      npm?.ignore?.some((rule) => rule["dependency-name"] === "@actions/*"),
    ).toBe(false);
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

  it("groups routine development updates while keeping majors separate", () => {
    const npm = configuration.updates.find(
      (update) => update["package-ecosystem"] === "npm",
    );

    expect(npm?.groups?.["development-dependencies"]).toEqual({
      "dependency-type": "development",
      "update-types": ["minor", "patch"],
    });
  });

  it("checks GitHub Actions weekly and groups non-major updates", () => {
    const actions = configuration.updates.find(
      (update) => update["package-ecosystem"] === "github-actions",
    );

    expect(actions?.schedule.interval).toBe("weekly");
    expect(actions?.groups?.["github-actions"]).toEqual({
      "patterns": ["*"],
      "update-types": ["minor", "patch"],
    });
  });
});

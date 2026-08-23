import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface ActionMetadata {
  readonly inputs: Record<
    string,
    { readonly default?: string; readonly required?: boolean }
  >;
  readonly outputs: Record<string, { readonly description: string }>;
  readonly runs: { readonly main: string; readonly using: string };
}

const metadata = parse(readFileSync("action.yml", "utf8")) as ActionMetadata;

describe("action metadata", () => {
  it("declares the stable v2 input contract", () => {
    expect(new Set(Object.keys(metadata.inputs))).toEqual(
      new Set([
        "token",
        "auto-merge",
        "author-login",
        "cooldown-days",
        "update-day",
        "update-branch",
        "branch-prefix",
        "label",
        "commit-message",
        "pr-title",
        "add-paths",
      ]),
    );
    expect(metadata.inputs.token?.default).toBe("${{ github.token }}");
    expect(metadata.inputs["auto-merge"]?.default).toBe("false");
    expect(metadata.inputs["author-login"]?.default).toBe(
      "github-actions[bot]",
    );
    expect(metadata.inputs["cooldown-days"]?.default).toBe("7");
    expect(metadata.inputs["update-day"]?.default).toBe("1");
    expect(metadata.inputs["update-branch"]?.default).toBe(
      "chore/prek-updates",
    );
    expect(metadata.inputs["branch-prefix"]?.default).toBe(
      "chore/prek-updates",
    );
    expect(metadata.inputs.label?.default).toBe("dependencies");
    expect(metadata.inputs["commit-message"]?.default).toBe(
      "chore: update prek hooks",
    );
    expect(metadata.inputs["pr-title"]?.default).toBe("Bump prek Hooks");
    expect(metadata.inputs["add-paths"]?.default).toBe("");
  });

  it("runs the checked-in Node 24 bundle and exposes its output", () => {
    expect(metadata.runs).toEqual({
      using: "node24",
      main: "dist/index.js",
    });
    expect(metadata.outputs).toHaveProperty("pull-request-number");
  });
});

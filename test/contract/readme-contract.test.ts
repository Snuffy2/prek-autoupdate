import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const readme = readFileSync("README.md", "utf8");

function isMapping(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function actionStepLists(value: unknown): readonly (readonly unknown[])[] {
  if (Array.isArray(value)) {
    const containsAction = value.some(
      (item) =>
        isMapping(item) &&
        typeof item.uses === "string" &&
        item.uses.startsWith("Snuffy2/prek-autoupdate@"),
    );
    return [
      ...(containsAction ? [value] : []),
      ...value.flatMap(actionStepLists),
    ];
  }
  if (isMapping(value)) {
    return Object.values(value).flatMap(actionStepLists);
  }
  return [];
}

describe("documented callers", () => {
  it("check out the target repository without persisting credentials", () => {
    const yamlBlocks = [
      ...readme.matchAll(/```yaml\n(?<yaml>[\s\S]*?)\n```/gu),
    ];
    const documentedCallers = yamlBlocks.flatMap((match) => {
      const yaml = match.groups?.yaml ?? "";
      return yaml.includes("Snuffy2/prek-autoupdate@")
        ? actionStepLists(parse(yaml) as unknown)
        : [];
    });

    expect(documentedCallers.length).toBeGreaterThan(0);
    for (const steps of documentedCallers) {
      const actionIndex = steps.findIndex(
        (step) =>
          isMapping(step) &&
          typeof step.uses === "string" &&
          step.uses.startsWith("Snuffy2/prek-autoupdate@"),
      );
      const checkout = steps
        .slice(0, actionIndex)
        .find(
          (step) =>
            isMapping(step) &&
            typeof step.uses === "string" &&
            step.uses.startsWith("actions/checkout@"),
        );

      expect(checkout).toBeDefined();
      expect(isMapping(checkout) && isMapping(checkout.with)).toBe(true);
      if (isMapping(checkout) && isMapping(checkout.with)) {
        expect(checkout.with["persist-credentials"]).toBe(false);
      }
    }
  });
});

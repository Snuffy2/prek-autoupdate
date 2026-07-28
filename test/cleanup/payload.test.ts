import { describe, expect, it } from "vitest";

import {
  closeIdentity,
  closedDeletionIdentity,
  headRef,
  payload,
  pullChangedFiles,
  pullNumber,
  sameRepoHeadRef,
} from "../../src/cleanup/payload.js";

describe("cleanup payload validation", () => {
  it.each([null, [], "pull", 1])("rejects non-object payload %j", (value) => {
    expect(() => payload(value, "pull request object")).toThrow(
      "Expected pull request object",
    );
  });

  it.each([undefined, -1, 1.5, "x", {}, null])(
    "rejects malformed pull numbers %j",
    (number) => {
      expect(() => pullNumber({ number })).toThrow("numeric number");
    },
  );

  it("accepts an integer-shaped pull number string", () => {
    expect(pullNumber({ number: "42" })).toBe(42);
  });

  it.each([undefined, -1, 1.5, "1", null])(
    "rejects malformed changed-file counts %j",
    (changed_files) => {
      expect(() => pullChangedFiles({ changed_files })).toThrow(
        "valid changed file count",
      );
    },
  );

  it.each([
    {},
    { head: null },
    { head: [] },
    { head: { ref: "branch" } },
    { head: { ref: "branch", repo: null } },
    { head: { ref: "branch", repo: { full_name: "other/repo" } } },
  ])("rejects malformed or foreign head identity %j", (pull) => {
    expect(sameRepoHeadRef(pull, "owner/repo")).toBeUndefined();
  });

  it("throws when a required head ref is missing", () => {
    expect(() => headRef({ head: {} })).toThrow("missing a head ref");
  });

  it.each([
    ["missing closed timestamp", { closed_at: null }],
    ["merged pull", { merged_at: "now" }],
    ["invalid count", { changed_files: -1 }],
    ["missing head", { head: null }],
  ])("rejects incomplete close identity: %s", (_name, override) => {
    expect(
      closeIdentity({
        number: 1,
        state: "closed",
        merged_at: null,
        changed_files: 1,
        updated_at: "now",
        closed_at: "now",
        head: { ref: "branch", sha: "sha" },
        base: { ref: "main" },
        ...override,
      }),
    ).toBeUndefined();
  });

  it.each([{ number: "1" }, { updated_at: null }, { head: { ref: "branch" } }])(
    "rejects incomplete closed deletion identity %j",
    (override) => {
      expect(
        closedDeletionIdentity({
          number: 1,
          updated_at: "now",
          merged_at: null,
          head: { ref: "branch", sha: "sha" },
          ...override,
        }),
      ).toBeUndefined();
    },
  );
});

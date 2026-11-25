import { describe, expect, it } from "vitest";

import { cleanupWithApi } from "../../src/cleanup/index.js";
import type { ActionExecution } from "../../src/contracts.js";
import type { Payload } from "../../src/github.js";
import { InMemoryGitHub } from "../support/in-memory-github.js";

const branch = "prek-autoupdate";
const repository = "owner/repo";
const marker = "Automated update of `prek` hooks.";

type TestPull = Payload & { number: number };

function pull(overrides: Partial<TestPull> = {}): TestPull {
  return {
    number: 1,
    state: "open",
    merged_at: null,
    changed_files: 1,
    updated_at: "2026-01-01T00:00:00Z",
    closed_at: null,
    body: marker,
    labels: [{ name: "dependencies" }],
    user: { login: "github-actions[bot]" },
    head: { ref: branch, sha: "head", repo: { full_name: repository } },
    base: { ref: "main" },
    ...overrides,
  };
}

function closed(overrides: Partial<TestPull> = {}): TestPull {
  return pull({
    state: "closed",
    updated_at: "2026-01-01T00:01:00Z",
    closed_at: "2026-01-01T00:01:00Z",
    ...overrides,
  });
}

function pullOnBranch(number: number, suffix: string): TestPull {
  return pull({
    number,
    head: {
      ref: `${branch}-${suffix}`,
      sha: suffix,
      repo: { full_name: repository },
    },
  });
}

const execution: Pick<ActionExecution, "context" | "inputs"> = {
  context: {
    eventName: "schedule",
    owner: "owner",
    repository: "repo",
    repositoryFullName: repository,
    serverUrl: "https://github.com",
    workspace: "/workspace",
    baseBranch: "main",
    baseSha: "base",
    authenticatedLogin: "github-actions[bot]",
    tokenAuthenticatedAsUser: false,
  },
  inputs: {
    token: "token",
    autoMerge: false,
    authorLogin: "",
    cooldownDays: "7",
    updateDay: 1,
    updateBranch: branch,
    branchPrefix: "prek-autoupdate",
    label: "dependencies",
    commitMessage: "update",
    prTitle: "update",
    addPaths: [],
  },
};

const headRef = `heads/${branch}`;
const push = {
  ...execution,
  context: { ...execution.context, eventName: "push" as const },
};
const unchanged = { closedPullRequests: [], deletedBranches: [] };

function seed(...pulls: TestPull[]): InMemoryGitHub {
  const github = new InMemoryGitHub(pulls);
  github.refs.set("heads/main", "base");
  github.refs.set(headRef, "head");
  return github;
}

function zeroChange(): InMemoryGitHub {
  return seed(pull({ changed_files: 0 }));
}

function compare(
  github: InMemoryGitHub,
  files: Payload[],
  head: ReadonlyMap<string, string> | undefined,
  base: ReadonlyMap<string, string> | undefined,
): void {
  github.comparisons.set("base...head", files);
  github.trees.set("head", head);
  github.trees.set("base", base);
}

describe("cleanupUpdateBranches safety behavior", () => {
  it("protects an unverified creation and the configured update branch while retaining the latest owned pull", async () => {
    const github = seed(
      closed({ number: 4 }),
      pullOnBranch(1, "stale"),
      pullOnBranch(2, "unverified"),
      pullOnBranch(3, "latest"),
    );
    for (const suffix of ["stale", "unverified", "latest"]) {
      github.refs.set(`heads/${branch}-${suffix}`, suffix);
    }

    await expect(
      cleanupWithApi(github, execution, {
        unverifiedCreatedPullRequestNumber: 2,
      }),
    ).resolves.toEqual({ closedPullRequests: [1], deletedBranches: [] });
    expect(github.pulls.get(1)?.state).toBe("closed");
    expect(github.pulls.get(2)?.state).toBe("open");
    expect(github.pulls.get(3)?.state).toBe("open");
    expect(github.refs.get(headRef)).toBe("head");
    expect(github.refs.get(`heads/${branch}-unverified`)).toBe("unverified");
    expect(github.refs.get(`heads/${branch}-latest`)).toBe("latest");
  });

  it("retains the published pull over a higher-numbered owned pull and preserves the newly closed ref", async () => {
    const staleBranch = "prek-autoupdate-stale";
    const github = seed(pull(), pullOnBranch(2, "stale"));
    github.refs.set(`heads/${staleBranch}`, "stale");

    await expect(
      cleanupWithApi(github, execution, { publishedPullRequestNumber: 1 }),
    ).resolves.toEqual({
      closedPullRequests: [2],
      deletedBranches: [],
    });
    expect(github.pulls.get(1)?.state).toBe("open");
    expect(github.pulls.get(2)?.state).toBe("closed");
    expect(github.refs.get(headRef)).toBe("head");
    expect(github.refs.get(`heads/${staleBranch}`)).toBe("stale");
  });

  it("retains the highest-numbered open owned pull on manual dispatch without a publication", async () => {
    const github = seed(pullOnBranch(2, "latest"), pull(), {
      ...pullOnBranch(3, "human"),
      labels: [],
      user: { login: "human" },
    });
    github.refs.set(`heads/${branch}-latest`, "latest");
    const dispatch = {
      ...execution,
      context: {
        ...execution.context,
        eventName: "workflow_dispatch" as const,
      },
    };

    await expect(cleanupWithApi(github, dispatch, {})).resolves.toEqual({
      closedPullRequests: [1],
      deletedBranches: [],
    });
    expect(github.pulls.get(1)?.state).toBe("closed");
    expect(github.pulls.get(2)?.state).toBe("open");
    expect(github.pulls.get(3)?.state).toBe("open");
    expect(github.refs.get(`heads/${branch}-latest`)).toBe("latest");
  });

  it("preserves an open pull that loses its label after listing", async () => {
    const github = seed(pull(), pullOnBranch(2, "latest"));
    github.transitions.afterListPulls = (state) => {
      if (state === "open") github.patchPull(1, { labels: [] });
    };

    await expect(cleanupWithApi(github, execution, {})).resolves.toEqual(
      unchanged,
    );
    expect(github.pulls.get(1)).toMatchObject({ state: "open", labels: [] });
    expect(github.refs.get(headRef)).toBe("head");
  });

  it.each([
    ["another author", { user: { login: "other" } }, branch],
    ["a missing body marker", { body: "other" }, branch],
    ["a missing ownership label", { labels: [] }, branch],
    [
      "a fork head",
      { head: { ref: branch, sha: "head", repo: { full_name: "fork/repo" } } },
      branch,
    ],
    ["another base branch", { base: { ref: "release" } }, branch],
    [
      "a head outside the update namespace",
      {
        head: { ref: "unowned", sha: "head", repo: { full_name: repository } },
      },
      "unowned",
    ],
  ] satisfies [string, Payload, string][])(
    "preserves open and closed pull requests and refs with %s",
    async (_reason, overrides, headBranch) => {
      for (const candidate of [pull(overrides), closed(overrides)]) {
        const github = new InMemoryGitHub([
          candidate,
          pullOnBranch(2, "latest"),
        ]);
        const ref = `heads/${headBranch}`;
        github.refs.set(ref, "head");

        await expect(cleanupWithApi(github, execution, {})).resolves.toEqual(
          unchanged,
        );
        expect(github.pulls.get(1)).toEqual(candidate);
        expect(github.refs.get(ref)).toBe("head");
      }
    },
  );

  it("preserves a closed pull's branch when its revision differs", async () => {
    const github = seed(closed());
    github.refs.set(headRef, "moved");

    await expect(cleanupWithApi(github, execution, {})).resolves.toEqual(
      unchanged,
    );
    expect(github.refs.get(headRef)).toBe("moved");
  });

  it("preserves a closed pull's branch shared with an unrelated open pull", async () => {
    const open = pull({ number: 9, labels: [], user: { login: "human" } });
    const github = seed(closed(), open);

    await expect(cleanupWithApi(github, execution, {})).resolves.toEqual(
      unchanged,
    );
    expect(github.pulls.get(9)).toEqual(open);
    expect(github.refs.get(headRef)).toBe("head");
  });

  it.each([branch, "automation/old"])(
    "deletes the owned branch %s at the queued revision",
    async (headBranch) => {
      const ref = `heads/${headBranch}`;
      const candidate = closed({
        head: { ref: headBranch, sha: "head", repo: { full_name: repository } },
      });
      const github = new InMemoryGitHub([candidate]);
      github.refs.set(ref, "head");

      await expect(
        cleanupWithApi(
          github,
          {
            ...execution,
            inputs: { ...execution.inputs, branchPrefix: "automation/" },
          },
          {},
        ),
      ).resolves.toEqual({
        closedPullRequests: [],
        deletedBranches: [headBranch],
      });
      expect(github.refs.has(ref)).toBe(false);
      expect(github.pulls.get(1)).toEqual(candidate);
    },
  );

  it.each(["head", "other"] as const)(
    "preserves a reused branch when conflicting evidence leaves it at %s",
    async (finalRevision) => {
      const github = seed(
        closed(),
        closed({
          number: 2,
          head: { ref: branch, sha: "other", repo: { full_name: repository } },
        }),
      );
      github.transitions.afterReadRef = (ref) => {
        if (ref !== headRef) return;
        if (github.refs.get(ref) === "head") github.refs.set(ref, "other");
        else {
          if (finalRevision === "head") github.refs.set(ref, "head");
          delete github.transitions.afterReadRef;
        }
      };

      await expect(cleanupWithApi(github, execution, {})).resolves.toEqual(
        unchanged,
      );
      expect(github.refs.get(headRef)).toBe(finalRevision);
    },
  );

  it("on push closes the newest obsolete pull and preserves the still-needed pull and both refs", async () => {
    const obsoleteBranch = "prek-autoupdate-obsolete";
    const github = seed(pull(), {
      ...pullOnBranch(2, "obsolete"),
      changed_files: 0,
    });
    github.refs.set(`heads/${obsoleteBranch}`, "obsolete");
    compare(
      github,
      [{ filename: "a" }],
      new Map([["a", "proposed"]]),
      new Map([["a", "current"]]),
    );

    await expect(cleanupWithApi(github, push, {})).resolves.toEqual({
      closedPullRequests: [2],
      deletedBranches: [],
    });
    expect(github.pulls.get(1)?.state).toBe("open");
    expect(github.pulls.get(2)?.state).toBe("closed");
    expect(github.refs.get(headRef)).toBe("head");
    expect(github.refs.get(`heads/${obsoleteBranch}`)).toBe("obsolete");
  });

  it("reopens the exact close when the branch revision no longer matches", async () => {
    const github = zeroChange();
    github.transitions.afterClosePull = () => {
      github.refs.set(headRef, "moved");
    };

    await expect(cleanupWithApi(github, push, {})).resolves.toEqual(unchanged);
    expect(github.pulls.get(1)).toMatchObject({
      state: "open",
      closed_at: null,
    });
    expect(github.refs.get(headRef)).toBe("moved");
  });

  it("preserves a pull with different tree identities despite a complete comparison", async () => {
    const github = seed(pull());
    compare(
      github,
      [{ filename: "a" }],
      new Map([["a", "100644\0blob\0same"]]),
      new Map([["a", "100644\0blob\0different"]]),
    );

    await expect(cleanupWithApi(github, push, {})).resolves.toEqual(unchanged);
    expect(github.pulls.get(1)?.state).toBe("open");
  });

  it.each([
    ["changed-file count", [{ filename: "a" }], 2],
    ["empty comparison", [], 1],
  ] as const)(
    "preserves when %s evidence is incomplete",
    async (_name, files, count) => {
      const github = seed(pull({ changed_files: count }));
      github.comparisons.set("base...head", files);

      await expect(cleanupWithApi(github, push, {})).resolves.toEqual(
        unchanged,
      );
      expect(github.pulls.get(1)?.state).toBe("open");
    },
  );

  it("skips an over-limit comparison truncated to 300 files", async () => {
    const github = seed(pull({ changed_files: 301 }));
    github.comparisons.set(
      "base...head",
      Array.from({ length: 300 }, (_, index) => ({ filename: `${index}` })),
    );

    await expect(cleanupWithApi(github, push, {})).resolves.toEqual(unchanged);
    expect(github.pulls.get(1)?.state).toBe("open");
  });

  it.each([
    ["matching", "closed", "old-id", [1]],
    ["different", "open", "other-id", []],
  ] as const)(
    "handles a rename with %s tree evidence for its old path",
    async (_name, state, baseOld, closedPullRequests) => {
      const github = seed(pull());
      compare(
        github,
        [{ filename: "new", previous_filename: "old" }],
        new Map([
          ["new", "new-id"],
          ["old", "old-id"],
        ]),
        new Map([
          ["new", "new-id"],
          ["old", baseOld],
        ]),
      );

      await expect(cleanupWithApi(github, push, {})).resolves.toEqual({
        closedPullRequests,
        deletedBranches: [],
      });
      expect(github.pulls.get(1)?.state).toBe(state);
    },
  );

  it.each(["head", "base"])(
    "preserves when the %s tree is truncated",
    async (revision) => {
      const github = seed(pull());
      const tree = new Map([["a", "same"]]);
      compare(github, [{ filename: "a" }], tree, tree);
      github.trees.set(revision, undefined);

      await expect(cleanupWithApi(github, push, {})).resolves.toEqual(
        unchanged,
      );
      expect(github.pulls.get(1)?.state).toBe("open");
    },
  );

  it.each(["head", "base"])(
    "preserves an obsolete pull when the %s moves during comparison",
    async (side) => {
      const github = seed(pull());
      const tree = new Map([["a", "same"]]);
      compare(github, [{ filename: "a" }], tree, tree);
      github.transitions.afterCompare = () => {
        if (side === "base") github.refs.set("heads/main", "moved");
        else {
          github.refs.set(headRef, "moved");
          github.patchPull(1, {
            head: {
              ref: branch,
              sha: "moved",
              repo: { full_name: repository },
            },
          });
        }
      };

      await expect(cleanupWithApi(github, push, {})).resolves.toEqual(
        unchanged,
      );
      expect(github.pulls.get(1)?.state).toBe("open");
      expect(github.refs.get(side === "base" ? "heads/main" : headRef)).toBe(
        "moved",
      );
    },
  );

  it("reopens the exact close after the base moves post-close", async () => {
    const github = zeroChange();
    github.transitions.afterClosePull = () => {
      github.refs.set("heads/main", "moved");
    };

    await expect(cleanupWithApi(github, push, {})).resolves.toEqual(unchanged);
    expect(github.pulls.get(1)?.state).toBe("open");
    expect(github.refs.get("heads/main")).toBe("moved");
  });

  it("reopens a pull after a new head revision with the same close event", async () => {
    const github = zeroChange();
    github.transitions.afterClosePull = () => {
      github.refs.set(headRef, "new");
      github.patchPull(1, {
        head: { ref: branch, sha: "new", repo: { full_name: repository } },
      });
    };

    await expect(cleanupWithApi(github, push, {})).resolves.toEqual(unchanged);
    expect(github.pulls.get(1)).toMatchObject({
      state: "open",
      head: { sha: "new" },
    });
    expect(github.refs.get(headRef)).toBe("new");
  });

  it.each([
    ["independent reclose", { updated_at: "later", closed_at: "later" }],
    ["a changed close timestamp alone", { closed_at: "later" }],
    ["moved base", { base: { ref: "release" } }],
    ["lost ownership", { labels: [] }],
  ])("does not compensate after %s", async (_name, override) => {
    const github = zeroChange();
    github.transitions.afterClosePull = () => {
      github.refs.set(headRef, "moved");
      github.patchPull(1, override);
    };

    await expect(cleanupWithApi(github, push, {})).resolves.toEqual(unchanged);
    expect(github.pulls.get(1)).toMatchObject({ state: "closed", ...override });
    expect(github.refs.get(headRef)).toBe("moved");
  });

  function invalidSnapshot(): InMemoryGitHub {
    const github = zeroChange();
    github.transitions.afterClosePull = () => {
      github.patchPull(1, { changed_files: -1 });
    };
    github.transitions.afterReadPull = (snapshot) => {
      if (snapshot?.changed_files === -1)
        github.patchPull(1, { changed_files: 0 });
    };
    return github;
  }

  it("propagates invalid snapshot evidence after reopening the exact close", async () => {
    const github = invalidSnapshot();

    await expect(cleanupWithApi(github, push, {})).rejects.toThrow(
      "valid changed file count",
    );
    expect(github.pulls.get(1)?.state).toBe("open");
  });

  it("retains snapshot and compensation errors when reopening fails", async () => {
    const github = invalidSnapshot();
    const compensation = new Error("reopen failed");
    github.transitions.beforeReopenPull = () => {
      throw compensation;
    };

    await expect(cleanupWithApi(github, push, {})).rejects.toMatchObject({
      errors: [
        expect.objectContaining({
          message: expect.stringContaining("valid changed file count"),
        }),
        compensation,
      ],
    });
    expect(github.pulls.get(1)?.state).toBe("closed");
  });

  it("skips a pull that vanishes while checking the branch after a close", async () => {
    const github = zeroChange();
    github.transitions.afterClosePull = () => {
      github.refs.set(headRef, "moved");
      github.transitions.afterReadRef = (ref) => {
        if (ref === headRef) github.pulls.delete(1);
      };
    };

    await expect(cleanupWithApi(github, push, {})).resolves.toEqual(unchanged);
    expect(github.pulls.has(1)).toBe(false);
    expect(github.refs.get(headRef)).toBe("moved");
  });

  it("reports a transient pull refresh failure during compensation", async () => {
    const github = zeroChange();
    const timeout = new Error("pull refresh timed out");
    github.transitions.afterClosePull = () => {
      github.refs.set(headRef, "moved");
      github.transitions.afterReadRef = (ref) => {
        if (ref === headRef) {
          github.transitions.beforeReadPull = () => {
            throw timeout;
          };
        }
      };
    };

    await expect(cleanupWithApi(github, push, {})).rejects.toMatchObject({
      errors: [timeout, timeout],
    });
    expect(github.pulls.get(1)?.state).toBe("closed");
  });

  it.each([
    ["is removed", undefined],
    ["moves", "concurrent"],
  ] as const)(
    "does not report deletion when the ref %s before the lease takes effect",
    async (_name, revision) => {
      const github = seed(closed());
      github.transitions.beforeDeleteRef = (ref) => {
        if (revision === undefined) github.refs.delete(ref);
        else github.refs.set(ref, revision);
      };

      await expect(cleanupWithApi(github, execution, {})).resolves.toEqual(
        unchanged,
      );
      expect(github.refs.get(headRef)).toBe(revision);
    },
  );

  it("blocks deletion when a pull opens after the closed candidate is checked", async () => {
    const github = seed(closed());
    let deleted = false;
    github.transitions.afterReadPull = (snapshot) => {
      if (snapshot?.state === "closed")
        github.pulls.set(9, pull({ number: 9 }));
    };
    github.transitions.afterDeleteRef = () => {
      deleted = true;
    };

    await expect(cleanupWithApi(github, execution, {})).resolves.toEqual(
      unchanged,
    );
    expect(github.refs.get(headRef)).toBe("head");
    expect(github.pulls.get(9)?.state).toBe("open");
    expect(deleted).toBe(false);
  });

  function openAfterDeletion(): InMemoryGitHub {
    const github = seed(closed());
    github.transitions.afterDeleteRef = () => {
      github.pulls.set(9, pull({ number: 9 }));
    };
    return github;
  }

  it("restores the leased revision when a pull opens after deletion", async () => {
    const github = openAfterDeletion();

    await expect(cleanupWithApi(github, execution, {})).resolves.toEqual(
      unchanged,
    );
    expect(github.refs.get(headRef)).toBe("head");
    expect(github.pulls.get(9)?.state).toBe("open");
  });

  it("preserves the revision of a ref concurrently recreated during restoration", async () => {
    const github = openAfterDeletion();
    github.transitions.beforeRestoreRef = (ref) => {
      github.refs.set(ref, "concurrent");
    };

    await expect(cleanupWithApi(github, execution, {})).resolves.toEqual(
      unchanged,
    );
    expect(github.refs.get(headRef)).toBe("concurrent");
    expect(github.pulls.get(9)?.state).toBe("open");
  });

  it("retains validation and transient restoration failures", async () => {
    const github = openAfterDeletion();
    const firstRestore = new Error("restore timeout");
    const retryRestore = new Error("restore retry timeout");
    github.transitions.beforeRestoreRef = () => {
      github.transitions.beforeRestoreRef = () => {
        throw retryRestore;
      };
      throw firstRestore;
    };

    await expect(cleanupWithApi(github, execution, {})).rejects.toMatchObject({
      errors: [firstRestore, retryRestore],
    });
    expect(github.refs.has(headRef)).toBe(false);
    expect(github.pulls.get(9)?.state).toBe("open");
  });

  it.each([
    ["updated timestamp", { updated_at: "later" }],
    ["merge classification", { merged_at: "2026-01-01T00:02:00Z" }],
    ["ownership", { body: "unowned" }],
  ])("blocks closed deletion after changed %s", async (_name, override) => {
    const github = seed(closed());
    github.transitions.afterListPulls = (state) => {
      if (state === "closed") github.patchPull(1, override);
    };

    await expect(cleanupWithApi(github, execution, {})).resolves.toEqual(
      unchanged,
    );
    expect(github.pulls.get(1)).toMatchObject({ state: "closed", ...override });
    expect(github.refs.get(headRef)).toBe("head");
  });

  it.each([execution, push])(
    "deletes merged and unmerged owned branches on $context.eventName",
    async (eventExecution) => {
      const merged = closed({
        number: 2,
        merged_at: "2026-01-01T00:01:00Z",
        head: {
          ref: "prek-autoupdate-2",
          sha: "head2",
          repo: { full_name: repository },
        },
      });
      const github = seed(closed(), merged);
      github.refs.set("heads/prek-autoupdate-2", "head2");

      await expect(cleanupWithApi(github, eventExecution, {})).resolves.toEqual(
        {
          closedPullRequests: [],
          deletedBranches: [branch, "prek-autoupdate-2"],
        },
      );
      expect([...github.refs]).toEqual([["heads/main", "base"]]);
      expect(github.pulls.get(2)).toEqual(merged);
    },
  );
});

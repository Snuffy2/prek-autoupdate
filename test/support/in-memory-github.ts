import type { DeleteRefOutcome } from "../../src/git.js";
import {
  ensureLabelExists,
  type AutoMergePull,
  type GitHubApi,
  type NewPull,
  type Payload,
  type PullListing,
  type PullMetadata,
  type PullResponse,
} from "../../src/github.js";

type PullState = "closed" | "open";
type TreeEntries = ReadonlyMap<string, string | undefined>;
type Transition<T> = (value: T) => void | Promise<void>;

interface Transitions {
  afterListPulls?: Transition<PullState | "all">;
  beforeCreatePull?: Transition<NewPull>;
  beforeUpdatePull?: Transition<{
    number: number;
    changes: PullMetadata | { state: PullState };
  }>;
  afterUpdatePull?: Transition<PullResponse>;
  beforeLookupLabel?: Transition<string>;
  beforeCreateLabel?: Transition<string>;
  beforeAddLabel?: Transition<{ number: number; name: string }>;
  beforeReadRef?: Transition<string>;
  beforeReadPull?: Transition<number>;
  afterReadPull?: Transition<Payload | undefined>;
  afterClosePull?: Transition<number>;
  beforeReadAutoMergePull?: Transition<number>;
  beforeEnableAutoMerge?: Transition<number>;
  afterEnableAutoMerge?: Transition<number>;
  beforeReopenPull?: Transition<number>;
  afterCompare?: Transition<{ baseSha: string; headSha: string }>;
  afterReadRef?: Transition<string>;
  beforeDeleteRef?: Transition<string>;
  afterDeleteRef?: Transition<string>;
  beforeRestoreRef?: Transition<string>;
}

/** Repository state and external changes that can occur at an API boundary. */
export class InMemoryGitHub implements GitHubApi {
  public readonly autoMergeRequests = new Map<number, string>();
  public readonly pulls = new Map<number, Payload>();
  public readonly labels = new Map<string, string>();
  public readonly pullEtags = new Map<number, string>();
  public readonly refs = new Map<string, string>();
  public readonly comparisons = new Map<string, readonly Payload[]>();
  public readonly trees = new Map<string, TreeEntries | undefined>();
  public readonly transitions: Transitions = {};
  private pullRevision = 0;

  public constructor(
    pulls: readonly (Payload & { number: number })[] = [],
    private readonly authenticatedLogin = "github-actions[bot]",
    private readonly repository = "owner/repo",
  ) {
    for (const pull of pulls)
      this.pulls.set(pull.number, structuredClone(pull));
  }

  public patchPull(number: number, patch: Payload): void {
    this.pulls.set(number, { ...this.requirePull(number), ...patch });
    this.pullEtags.set(number, `"pull-${number}-${++this.pullRevision}"`);
  }

  public async listPulls(
    state: PullState | "all",
    filters?: PullListing,
  ): Promise<Payload[]> {
    const owner = this.repository.split("/")[0];
    const listed = structuredClone(
      [...this.pulls.values()].filter((pull) => {
        const head = pull.head as {
          ref?: string;
          repo?: { full_name?: string };
        };
        const base = pull.base as { ref?: string };
        return (
          (state === "all" || pull.state === state) &&
          (filters?.head === undefined ||
            filters.head ===
              `${head.repo?.full_name?.split("/")[0] ?? owner}:${head.ref}`) &&
          (filters?.base === undefined || filters.base === base.ref)
        );
      }),
    );
    await this.transitions.afterListPulls?.(state);
    return listed;
  }

  public async createPull(pull: NewPull): Promise<number> {
    await this.transitions.beforeCreatePull?.(pull);
    const number = Math.max(41, ...this.pulls.keys()) + 1;
    this.pulls.set(number, {
      number,
      title: pull.title,
      body: pull.body,
      head: {
        ref: pull.head,
        sha: await this.requireRefSha(`heads/${pull.head}`),
        repo: { full_name: this.repository },
      },
      base: { ref: pull.base },
      state: "open",
      user: { login: this.authenticatedLogin },
      labels: [],
      updated_at: "2026-01-01T00:00:00Z",
      closed_at: null,
    });
    this.pullEtags.set(number, `"pull-${number}-${++this.pullRevision}"`);
    return number;
  }

  public async getPullWithEtag(number: number): Promise<PullResponse> {
    await this.transitions.beforeReadPull?.(number);
    const data = structuredClone(this.pulls.get(number));
    const etag = this.pullEtags.get(number);
    await this.transitions.afterReadPull?.(data);
    if (data === undefined) throw new Error(`Pull #${number} not found`);
    return {
      data,
      etag,
    };
  }

  public async updatePull(
    number: number,
    changes: PullMetadata | { state: PullState },
    ifMatch?: string,
  ): Promise<PullResponse> {
    await this.transitions.beforeUpdatePull?.({ number, changes });
    if (ifMatch !== undefined && this.pullEtags.get(number) !== ifMatch) {
      throw Object.assign(new Error("Pull request changed"), { status: 412 });
    }

    let data: Payload;
    let etag: string | undefined;
    if ("state" in changes && changes.state === "closed") {
      const closedAt = "2026-01-01T00:01:00Z";
      this.patchPull(number, {
        state: "closed",
        closed_at: closedAt,
        updated_at: closedAt,
      });
      etag = this.pullEtags.get(number);
      data = structuredClone(this.requirePull(number));
      await this.transitions.afterClosePull?.(number);
    } else {
      this.patchPull(
        number,
        "state" in changes ? { ...changes, closed_at: null } : { ...changes },
      );
      data = structuredClone(this.requirePull(number));
      etag = this.pullEtags.get(number);
    }
    const response = { data, etag };
    await this.transitions.afterUpdatePull?.(response);
    return response;
  }

  public ensureLabel(name: string): Promise<void> {
    return ensureLabelExists(
      async () => {
        await this.transitions.beforeLookupLabel?.(name);
        if (!this.labels.has(name))
          throw Object.assign(new Error("Label not found"), { status: 404 });
      },
      async () => {
        await this.transitions.beforeCreateLabel?.(name);
        if (this.labels.has(name))
          throw Object.assign(new Error("Label already exists"), {
            status: 422,
          });
        this.labels.set(name, "0366d6");
      },
    );
  }

  public async addLabel(number: number, name: string): Promise<void> {
    await this.transitions.beforeAddLabel?.({ number, name });
    if (!this.labels.has(name)) throw new Error(`Label ${name} not found`);
    const labels = this.requirePull(number).labels as Payload[];
    if (!labels.some((label) => label.name === name)) {
      this.patchPull(number, { labels: [...labels, { name }] });
    }
  }

  public async getPull(number: number): Promise<Payload> {
    const pull = await this.findPull(number);
    if (pull === undefined) throw new Error(`Pull #${number} not found`);
    return pull;
  }

  public async findPull(number: number): Promise<Payload | undefined> {
    await this.transitions.beforeReadPull?.(number);
    const pull = structuredClone(this.pulls.get(number));
    await this.transitions.afterReadPull?.(pull);
    return pull;
  }

  public async getAutoMergePull(number: number): Promise<AutoMergePull | null> {
    await this.transitions.beforeReadAutoMergePull?.(number);
    const pull = this.pulls.get(number);
    if (pull === undefined) return null;

    const head = pull.head as {
      ref: string;
      sha: string;
      repo?: { full_name: string };
    };
    return {
      id: `PR_${number}`,
      number: pull.number as number,
      state: String(pull.state).toUpperCase(),
      headSha: head.sha,
      author: (pull.user as { login: string } | null)?.login,
      body: pull.body as string,
      headRef: head.ref,
      headRepository: head.repo?.full_name,
      baseRef: (pull.base as { ref: string }).ref,
      labels: (pull.labels as { name: string }[]).map(({ name }) => name),
      mergeMethod: this.autoMergeRequests.get(number),
    };
  }

  public async enableSquashAutoMerge(
    id: string,
    expectedHeadOid: string,
  ): Promise<boolean> {
    const number = this.autoMergePullNumber(id);
    await this.transitions.beforeEnableAutoMerge?.(number);
    const pull = this.requirePull(number);
    if (
      pull.state !== "open" ||
      (pull.head as { sha: string }).sha !== expectedHeadOid
    )
      throw new Error("Auto-merge requires an open pull at the expected head");
    if (this.autoMergeRequests.has(number))
      throw new Error("Auto-merge is already enabled");
    this.autoMergeRequests.set(number, "SQUASH");
    await this.transitions.afterEnableAutoMerge?.(number);
    return true;
  }

  public async disableAutoMerge(id: string): Promise<void> {
    const number = this.autoMergePullNumber(id);
    this.autoMergeRequests.delete(number);
  }

  private autoMergePullNumber(id: string): number {
    const number = Number(id.slice("PR_".length));
    if (id !== `PR_${number}` || !this.pulls.has(number))
      throw new Error(`Pull ${id} not found`);
    return number;
  }

  public async closePull(number: number): Promise<Payload> {
    const closedAt = "2026-01-01T00:01:00Z";
    this.patchPull(number, {
      state: "closed",
      closed_at: closedAt,
      updated_at: closedAt,
    });
    const closed = structuredClone(this.requirePull(number));
    await this.transitions.afterClosePull?.(number);
    return closed;
  }

  public async reopenPull(number: number): Promise<Payload> {
    await this.transitions.beforeReopenPull?.(number);
    this.patchPull(number, { state: "open", closed_at: null });
    return this.getPull(number);
  }

  public async compareFiles(
    baseSha: string,
    headSha: string,
  ): Promise<Payload[]> {
    const files = this.comparisons.get(`${baseSha}...${headSha}`);
    if (files === undefined)
      throw new Error(`Comparison ${baseSha}...${headSha} not found`);
    await this.transitions.afterCompare?.({ baseSha, headSha });
    return structuredClone([...files]);
  }

  public getTreeEntries(
    paths: ReadonlySet<string>,
    ref: string,
  ): Promise<TreeEntries | undefined> {
    const tree = this.trees.get(ref);
    return Promise.resolve(
      tree === undefined
        ? undefined
        : new Map([...paths].map((path) => [path, tree.get(path)])),
    );
  }

  public async getRefSha(ref: string): Promise<string | undefined> {
    await this.transitions.beforeReadRef?.(ref);
    const sha = this.refs.get(ref);
    await this.transitions.afterReadRef?.(ref);
    return sha;
  }

  public async requireRefSha(ref: string): Promise<string> {
    const sha = await this.getRefSha(ref);
    if (sha === undefined) {
      throw Object.assign(new Error(`Ref ${ref} missing`), { status: 404 });
    }
    return sha;
  }

  public deleteRef: GitHubApi["deleteRef"] = async (
    ref,
    expectedSha,
  ): Promise<DeleteRefOutcome> => {
    await this.transitions.beforeDeleteRef?.(ref);
    const sha = this.refs.get(ref);
    if (sha === undefined) return "already-absent";
    if (sha !== expectedSha) return "lease-rejected";

    this.refs.delete(ref);
    await this.transitions.afterDeleteRef?.(ref);
    return "deleted";
  };

  public async restoreRef(ref: string, sha: string): Promise<void> {
    await this.transitions.beforeRestoreRef?.(ref);
    if (!this.refs.has(ref)) this.refs.set(ref, sha);
  }

  private requirePull(number: number): Payload {
    const pull = this.pulls.get(number);
    if (pull === undefined) throw new Error(`Pull #${number} not found`);
    return pull;
  }
}

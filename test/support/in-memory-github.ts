import type { DeleteRefOutcome } from "../../src/git.js";
import type { GitHubApi, Payload } from "../../src/github.js";

type PullState = "closed" | "open";
type TreeEntries = ReadonlyMap<string, string | undefined>;
type Transition<T> = (value: T) => void | Promise<void>;

interface Transitions {
  afterListPulls?: Transition<PullState>;
  beforeReadPull?: Transition<number>;
  afterReadPull?: Transition<Payload | undefined>;
  afterClosePull?: Transition<number>;
  beforeReopenPull?: Transition<number>;
  afterCompare?: Transition<{ baseSha: string; headSha: string }>;
  afterReadRef?: Transition<string>;
  beforeDeleteRef?: Transition<string>;
  afterDeleteRef?: Transition<string>;
  beforeRestoreRef?: Transition<string>;
}

/** Repository state and external changes that can occur at an API boundary. */
export class InMemoryGitHub implements GitHubApi {
  public readonly pulls = new Map<number, Payload>();
  public readonly refs = new Map<string, string>();
  public readonly comparisons = new Map<string, readonly Payload[]>();
  public readonly trees = new Map<string, TreeEntries | undefined>();
  public readonly transitions: Transitions = {};

  public constructor(pulls: readonly (Payload & { number: number })[] = []) {
    for (const pull of pulls)
      this.pulls.set(pull.number, structuredClone(pull));
  }

  public patchPull(number: number, patch: Payload): void {
    this.pulls.set(number, { ...this.requirePull(number), ...patch });
  }

  public async listPulls(state: PullState): Promise<Payload[]> {
    const listed = structuredClone(
      [...this.pulls.values()].filter((pull) => pull.state === state),
    );
    await this.transitions.afterListPulls?.(state);
    return listed;
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
    const sha = this.refs.get(ref);
    await this.transitions.afterReadRef?.(ref);
    return sha;
  }

  public async deleteRef(
    ref: string,
    expectedSha: string,
  ): Promise<DeleteRefOutcome> {
    await this.transitions.beforeDeleteRef?.(ref);
    const sha = this.refs.get(ref);
    if (sha === undefined) return "already-absent";
    if (sha !== expectedSha) return "lease-rejected";

    this.refs.delete(ref);
    await this.transitions.afterDeleteRef?.(ref);
    return "deleted";
  }

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

export interface DependabotPullRequestEvent {
  action?: string;
  repository?: {
    default_branch?: string;
    fork?: boolean;
    full_name?: string;
  };
  pull_request?: {
    base?: { ref?: string; sha?: string };
    head?: {
      ref?: string;
      repo?: { full_name?: string };
      sha?: string;
    };
    user?: { login?: string };
  };
}

export interface DependabotAuthorizationInput {
  ancestryProofs?: unknown[];
  changedFiles: string[];
  commits: unknown[];
  event: DependabotPullRequestEvent;
  trustedBaseDirectory?: string;
}

export function authorizeDependabotUpdate(
  input: DependabotAuthorizationInput,
): "github-actions" | "npm" | "uv";

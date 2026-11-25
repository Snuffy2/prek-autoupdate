# Coding Standards

Use these conventions when writing or reviewing code for the prek autoupdate
action. [AGENTS.md](AGENTS.md) defines the release contract, cleanup safeguards,
test requirements, and local validation gate.

## TypeScript and module boundaries

- Follow the [glossary](GLOSSARY.md) in names and test descriptions. Distinguish
  the base branch, update branch, and the specific revision involved in an
  operation.
- Use strict TypeScript and ESM. Use `.js` specifiers for relative imports
  between TypeScript modules, and mark type-only imports with `type`.
- State parameter and return types at module boundaries. Use `unknown` for
  unvalidated values and narrow them before use. Keep types local until they
  define a contract shared across modules.
- Keep workflow orchestration in `src/main.ts` and reuse the existing modules
  for input parsing, GitHub, Git, ownership, publication, and cleanup. Prefer
  direct calls and small functions with one responsibility. Extract shared logic
  when it represents the same rule at each call site.

## External input and side effects

- Validate action inputs and the fields used from GitHub responses before they
  drive decisions or mutations. Distinguish an expected missing resource from a
  failed request or an incomplete response.
- Use the shared ownership checks for pull requests and the Git helpers for
  revision-bound branch mutations. Keep retries and recovery scoped to the
  operation and revision the action observed.
- Pass subprocess arguments as an array and use the sanitized child environment.
  Keep tokens, derived credentials, and raw credential-bearing command errors
  out of logs and action output.
- Include operation context in errors and preserve safe causes. Release
  temporary resources on success and failure. If the operation and its cleanup
  both fail, retain both failures when they can be reported safely.

## Tests and formatting

- Put Vitest tests under `test/`. Exercise observable outcomes at the action,
  GitHub, or Git boundary. For mutation changes, assert resulting pull request
  and branch state on success and on the affected no-op, failure, or race path.
- Use the in-memory GitHub test support to simulate pull request state. Use a
  temporary Git repository when the test needs real ref or worktree behavior.
  Pick the smallest fixture that exercises the contract.
- Apply the [test requirements](AGENTS.md#tests), including the rules for
  regression tests and avoiding brittle assertions. Run formatting and linting
  through `prek` as described in the
  [local validation gate](AGENTS.md#node-and-tooling).

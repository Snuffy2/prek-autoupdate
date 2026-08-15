# AGENTS.md

This repository maintains the `prek` autoupdate JavaScript action. Keep changes
small, tested, and safe for downstream repositories that grant the action write
permissions.

## Repository Shape

- `action.yml` is the public action metadata and input/output contract.
- `src/` contains the strict TypeScript implementation.
- `dist/index.js` is the checked-in Rollup bundle executed by Node 24.
- `test/` contains Vitest behavior and public-contract tests.
- `README.md` is the end-user contract. Update it with any input, permission,
  token, output, platform, or caller-example change.

## Source Of Truth Rules

- Caller examples must check out the target repository with
  `actions/checkout` and `persist-credentials: false` before invoking the
  action.
- Keep the caller example's `push` trigger for `main` aligned with the
  cleanup-only reconciliation path. Pushes must not run `prek auto-update`,
  create a PR, or update a still-needed PR.
- Treat `action.yml`, `README.md`, and `dist/index.js` as the public release
  surface. Input or output changes require contract tests and documentation in
  the same change.
- Changes to action source, runtime dependencies, or bundle configuration must
  rebuild and commit `dist/index.js` in the same change.
- Support Linux x64 and arm64 runners. The action uses the Node 24 runtime.
- Do not request `actions: write`; no active path needs it.

## GitHub Tokens

- The normal path must work with the repository `GITHUB_TOKEN`.
- The `token` input remains generic. A GitHub App installation token or PAT may
  be used when generated PRs must trigger downstream CI that GitHub suppresses
  for `GITHUB_TOKEN`.
- Document the minimum token permissions and keep the authenticated identity
  consistent across PR creation, ownership checks, and cleanup.

## Cleanup Safety

- Branch and PR cleanup must prove ownership before mutating anything. Keep the
  label, author, body marker, same-repository head, and branch-prefix checks
  intact unless replacing them with stricter checks.
- Follow GitHub pagination until there is no next page.
- Branch deletion must be idempotent for missing refs and bound to the expected
  revision.

## Node And Tooling

- Use Node 24 and the committed npm lockfile.
- Keep TypeScript strict and bundle the action with Rollup.
- Run all linting and formatting through `prek`; do not invoke ESLint or Prettier
  directly. Use Vitest with v8 coverage for tests.
- Do not commit `node_modules/` or coverage output.

Run the full local gate:

```sh
npm ci
prek run --all-files
npm run test:coverage
npm run check:dist
```

## Tests

- Cleanup tests must cover ownership boundaries before branch deletion.
- Behavior fixes require a regression test that fails before the fix.
- Contract tests must cover the action runtime, input defaults, output, and the
  documented caller checkout.

### Brittle-test prohibition

- Never add tests that freeze incidental implementation or configuration
  details. Prohibited examples include exact dependency or Action versions,
  cache settings, step counts, cosmetic metadata, private helper structure,
  source-text or AST scans, and whole workflow/job snapshots.
- Do not turn a reviewer, linter, or security-tool preference into a test unless
  it is an explicit product requirement with an observable failure mode. In
  particular, never assert whether `actions/setup-node` caching is enabled or
  disabled unless cache behavior itself becomes part of the documented product
  contract.
- Assert observable behavior and durable security boundaries. Test ordering
  only when changing the order changes behavior, such as validating an exact
  release ref before using a potentially stale listing or performing a guarded
  compare-and-swap mutation.
- When an exact artifact is the supported contract, test only the smallest
  stable semantic property. Canonical-file equivalence checks are allowed when
  two published files must remain identical; do not duplicate the artifact's
  contents as a second policy mirror in test code.
- If a routine refactor, dependency update, Action update, or harmless workflow
  setting change breaks a test without changing product behavior, remove or
  replace the brittle test. Do not update its incidental literal and preserve
  the same coupling.
- Before adding a metadata or documentation test, state the user-visible or
  security failure it catches and why existing behavioral coverage is
  insufficient. If there is no concrete failure, do not add the test.

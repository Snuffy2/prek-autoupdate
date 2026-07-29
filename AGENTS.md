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
- Use ESLint, Prettier, and Vitest with v8 coverage.
- Do not commit `node_modules/` or coverage output.

Run the full local gate:

```sh
npm ci
npm run format:check
npm run lint
npm run typecheck
npm run test:coverage
npm run check:dist
```

## Tests

- Cleanup tests must cover ownership boundaries before branch deletion.
- Behavior fixes require a regression test that fails before the fix.
- Contract tests must cover the action runtime, input defaults, output, and the
  documented caller checkout.

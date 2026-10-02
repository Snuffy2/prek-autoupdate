# Releasing prek-autoupdate

Release Please runs on pushes to `main`, maintains a release pull request, and
publishes the version tag and GitHub release after that pull request is merged.
The manifest starts at the existing `2.0.8` release. Package and lockfile
versions are updated by Release Please using the Node release strategy.

Configure the `RELEASE_PLEASE_TOKEN` repository secret with a token that can
write repository contents and pull requests. As in the places repository, this
token allows release pull requests and their updates to trigger CI.

Use conventional commit titles when squash-merging pull requests, for example
`fix: handle missing refs` or `feat: support a new input`. The PR-title lint
checks the supported types copied from places. Use `!` or a `BREAKING CHANGE:`
footer for breaking changes.

Before merging a release pull request, review the release notes and version and
require CI to pass. The action reads its version from its own `package.json` at
runtime, so Release Please's package and lockfile version bumps do not require a
bundle rebuild. Source or runtime dependency changes still require rebuilding
and committing `dist/index.js`; CI verifies that the bundle is current.

After publication, the workflow verifies the checked-in bundle and promotes the
stable `vMAJOR` tag using the existing guarded, monotonic tag updater. It does
not rewrite the version tag or `main`. Prereleases are not promoted to stable
major tags.

If major-tag promotion fails, fix the cause and manually run **Release Please**
with the existing stable version tag, such as `v2.0.9`. This repeats validation
and promotion without creating another release.

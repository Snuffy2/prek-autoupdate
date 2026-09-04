# Releasing prek-autoupdate

Releases are driven by publishing a GitHub release. The release workflow does
not accept manual dispatch inputs.

## Stable releases

1. From the GitHub Releases page, create a release with a new semantic tag such
   as `v2.1.0`.
2. Set the target to the repository's default branch and leave **Set as a
   pre-release** cleared.
3. Publish the release.

The workflow verifies that the new tag and the default branch initially point to
the same commit. It updates `package.json`, `package-lock.json`, and
`dist/index.js`, creates a deterministic release commit when those files need
changes, and publishes that commit to a unique validation branch. It dispatches
CI for the exact candidate SHA and accepts only the authoritative run ID and the
successful `Node CI` and independent `prek-autofix` review jobs for that SHA.

After validation, one atomic, lease-guarded push advances both the default
branch and the published release tag. The workflow then verifies the final tag,
bundle, and version before updating the moving `vMAJOR` tag. A concurrent branch
or tag change causes the release to fail closed.

## Prereleases

Prepare and merge the versioned `package.json`, `package-lock.json`, and
`dist/index.js` before publishing a prerelease. Create its semantic prerelease
tag, such as `v2.1.0-beta.1`, from that matching default-branch commit and mark
the GitHub release as a prerelease.

Prerelease runs verify the tag, version, bundle, and ancestry. They do not move
the default branch, the point tag, or the stable `vMAJOR` tag.

## Recovery and reruns

Fix the condition that failed and rerun the same release workflow run. Do not
publish a second release for the same version.

Stable reruns recognize a completed `Release vX.Y.Z` commit when the point tag
still identifies that commit and the commit remains in the default branch's
history. They revalidate that immutable commit and safely repeat the final
identity and moving-tag checks. A failed validation may leave its uniquely named
`release-validation/...` branch for diagnosis; delete it only after confirming
it still points to the candidate SHA reported by the failed run.

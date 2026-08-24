#!/usr/bin/env bash
set -euo pipefail

if [[ "$RELEASE_REF" != "$DEFAULT_BRANCH" ]]; then
  echo "Release workflow must be dispatched from $DEFAULT_BRANCH, not $RELEASE_REF." >&2
  exit 1
fi

tag_is_prerelease=false
if [[ "$RELEASE_TAG" == *-* ]]; then
  tag_is_prerelease=true
fi
if [[ "$tag_is_prerelease" != "$IS_PRERELEASE" ]]; then
  echo "Release tag prerelease suffix and prerelease input must agree." >&2
  exit 1
fi

release_view_error="$RUNNER_TEMP/release-view-error.txt"
if existing_release="$(
  gh release view "$RELEASE_TAG" \
    --json isPrerelease \
    --jq .isPrerelease \
    2>"$release_view_error"
)"; then
  if [[ "$existing_release" != "$IS_PRERELEASE" ]]; then
    echo "Existing GitHub release prerelease state does not match the request." >&2
    exit 1
  fi
  echo "Resuming existing GitHub release: $RELEASE_TAG"
elif ! grep -Eq "HTTP 404|release not found" "$release_view_error"; then
  cat "$release_view_error" >&2
  exit 1
fi

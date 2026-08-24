#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${RELEASE_TAG:-}" ]]; then
  echo "RELEASE_TAG is required" >&2
  exit 1
fi
if [[ "${IS_PRERELEASE:-}" != "true" && "${IS_PRERELEASE:-}" != "false" ]]; then
  echo "IS_PRERELEASE must be true or false" >&2
  exit 1
fi

release_view_error="$RUNNER_TEMP/release-view-error.txt"
if release_state="$(
  gh release view "$RELEASE_TAG" \
    --json isDraft,isPrerelease \
    --jq '[.isDraft, .isPrerelease] | @tsv' \
    2>"$release_view_error"
)"; then
  IFS=$'\t' read -r is_draft is_prerelease <<< "$release_state"
  if [[ "$is_prerelease" != "$IS_PRERELEASE" ]]; then
    echo "Existing GitHub release prerelease state does not match the request." >&2
    exit 1
  fi
  if [[ "$is_draft" != "true" ]]; then
    echo "GitHub release is already published: $RELEASE_TAG"
    exit 0
  fi
  gh release edit "$RELEASE_TAG" --draft=false
elif grep -Eq "HTTP 404|release not found" "$release_view_error"; then
  release_args=(
    "$RELEASE_TAG"
    --generate-notes
    --title "$RELEASE_TAG"
    --verify-tag
  )
  if [[ "$IS_PRERELEASE" == "true" ]]; then
    release_args+=(--prerelease)
  fi
  gh release create "${release_args[@]}"
else
  cat "$release_view_error" >&2
  exit 1
fi

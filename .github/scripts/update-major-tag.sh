#!/usr/bin/env bash
set -euo pipefail

if [[ ! "$RELEASE_TAG" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo "Release tag must have vMAJOR.MINOR.PATCH form" >&2
  exit 1
fi
major_tag="v${BASH_REMATCH[1]}"
if [[ ! "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Verified release SHA is invalid" >&2
  exit 1
fi

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
tags_file="$(mktemp)"
releases_file="$(mktemp)"
trap 'rm -f "$tags_file" "$releases_file"' EXIT

read_remote_tag() {
  local tag="$1" description="$2" refs direct_oid peeled_oid
  if ! refs="$(
    git ls-remote origin "refs/tags/$tag" "refs/tags/$tag^{}"
  )"; then
    echo "Unable to read $description from origin" >&2
    return 1
  fi
  direct_oid="$(awk -v ref="refs/tags/$tag" '$2 == ref { print $1 }' <<< "$refs")"
  peeled_oid="$(awk -v ref="refs/tags/$tag^{}" '$2 == ref { print $1 }' <<< "$refs")"
  if [[ ! "$direct_oid" =~ ^[0-9a-f]{40}$ ]]; then
    echo "Origin returned an invalid $description" >&2
    return 1
  fi
  if [[ -z "$peeled_oid" ]]; then
    peeled_oid="$direct_oid"
  elif [[ ! "$peeled_oid" =~ ^[0-9a-f]{40}$ ]]; then
    echo "Origin returned an invalid peeled $description" >&2
    return 1
  fi
  printf '%s\t%s\n' "$direct_oid" "$peeled_oid"
}

verify_point_tag() {
  local point_ref direct_oid peeled_oid
  point_ref="$(read_remote_tag "$RELEASE_TAG" "release tag $RELEASE_TAG")" || exit 1
  IFS=$'\t' read -r direct_oid peeled_oid <<< "$point_ref"
  if [[ "$peeled_oid" != "$TARGET_SHA" ]]; then
    echo "Verified release SHA does not match its exact finalized tag ref" >&2
    exit 1
  fi
  printf '%s\t%s\n' "$direct_oid" "$peeled_oid"
}

release_direct_ref="$(verify_point_tag)"

verify_release_ref_unchanged() {
  local observed_release_ref
  observed_release_ref="$(verify_point_tag)"
  if [[ "$observed_release_ref" != "$release_direct_ref" ]]; then
    echo "$RELEASE_TAG changed while its update was being prepared" >&2
    return 1
  fi
}

gh api --paginate --slurp \
  "repos/$GITHUB_REPOSITORY/tags?per_page=100" > "$tags_file"
gh api --paginate --slurp \
  "repos/$GITHUB_REPOSITORY/releases?per_page=100" > "$releases_file"

decision="$(
  TAGS_FILE="$tags_file" RELEASES_FILE="$releases_file" \
    node "$script_directory/decide-major-tag.mjs"
)"

IFS=$'\t' read -r action update_sha before_oid <<< "$decision"

move_major_tag() {
  local major_before_oid="$1" restore_ref
  verify_release_ref_unchanged || return 1
  git cat-file -e "$update_sha^{commit}"
  git push \
    --force-with-lease="refs/tags/$major_tag:$major_before_oid" \
    origin "${update_sha}:refs/tags/$major_tag"
  if ! verify_release_ref_unchanged; then
    if [[ -n "$major_before_oid" ]]; then
      restore_ref="${major_before_oid}:refs/tags/$major_tag"
    else
      restore_ref=":refs/tags/$major_tag"
    fi
    if ! git push \
      --force-with-lease="refs/tags/$major_tag:$update_sha" \
      origin "$restore_ref"; then
      echo "Unable to restore $major_tag after $RELEASE_TAG changed" >&2
    fi
    return 1
  fi
}

case "$action" in
skip)
  verify_release_ref_unchanged || exit 1
  echo "$major_tag is newer than $RELEASE_TAG; leaving it unchanged"
  ;;
noop)
  verify_release_ref_unchanged || exit 1
  echo "$major_tag already points to $RELEASE_TAG"
  ;;
update)
  major_ref="$(read_remote_tag "$major_tag" "major tag $major_tag")" || exit 1
  IFS=$'\t' read -r direct_before_oid peeled_before_oid <<< "$major_ref"
  if [[ "$peeled_before_oid" != "$before_oid" ]]; then
    echo "$major_tag changed while its update was being prepared" >&2
    exit 1
  fi
  git cat-file -e "$direct_before_oid" 2>/dev/null || \
    git fetch --no-tags origin "refs/tags/$major_tag"
  git cat-file -e "$direct_before_oid"
  move_major_tag "$direct_before_oid"
  ;;
create)
  move_major_tag ""
  ;;
*)
  echo "Unable to determine a safe moving-tag update" >&2
  exit 1
  ;;
esac

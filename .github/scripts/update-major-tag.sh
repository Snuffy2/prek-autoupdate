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

verify_point_tag() {
  local attempt direct_ref object_oid object_type
  for attempt in 1 2 3 4 5; do
    if direct_ref="$(
      gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/$RELEASE_TAG" \
        --jq '.object | [.sha, .type] | @tsv' 2>/dev/null
    )"; then
      IFS=$'\t' read -r object_oid object_type <<< "$direct_ref"
      while [[ "$object_type" == "tag" ]]; do
        if ! direct_ref="$(
          gh api "repos/$GITHUB_REPOSITORY/git/tags/$object_oid" \
            --jq '.object | [.sha, .type] | @tsv' 2>/dev/null
        )"; then
          object_type=""
          break
        fi
        IFS=$'\t' read -r object_oid object_type <<< "$direct_ref"
      done
      if [[ "$object_type" == "commit" && "$object_oid" == "$TARGET_SHA" ]]; then
        return
      fi
    fi
    if (( attempt < 5 )); then
      sleep "$attempt"
    fi
  done
  echo "Verified release SHA does not match its exact immutable tag ref" >&2
  exit 1
}

verify_point_tag
gh api --paginate --slurp \
  "repos/$GITHUB_REPOSITORY/tags?per_page=100" > "$tags_file"
gh api --paginate --slurp \
  "repos/$GITHUB_REPOSITORY/releases?per_page=100" > "$releases_file"

decision="$(
  TAGS_FILE="$tags_file" RELEASES_FILE="$releases_file" \
    node "$script_directory/decide-major-tag.mjs"
)"

IFS=$'\t' read -r action update_sha before_oid <<< "$decision"
case "$action" in
skip)
  echo "$major_tag is newer than $RELEASE_TAG; leaving it unchanged"
  ;;
noop)
  echo "$major_tag already points to $RELEASE_TAG"
  ;;
update)
  IFS=$'\t' read -r direct_before_oid direct_type < <(
    gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/$major_tag" \
      --jq '.object | [.sha, .type] | @tsv'
  )
  peeled_oid="$direct_before_oid"
  peeled_type="$direct_type"
  while [[ "$peeled_type" == "tag" ]]; do
    IFS=$'\t' read -r peeled_oid peeled_type < <(
      gh api "repos/$GITHUB_REPOSITORY/git/tags/$peeled_oid" \
        --jq '.object | [.sha, .type] | @tsv'
    )
  done
  if [[ "$peeled_type" != "commit" || "$peeled_oid" != "$before_oid" ]]; then
    echo "$major_tag changed while its update was being prepared" >&2
    exit 1
  fi
  repository_id="$(gh api "repos/$GITHUB_REPOSITORY" --jq .node_id)"
  gh api graphql \
    -f query='
      mutation UpdateMajorTag(
        $repositoryId: ID!
        $name: GitRefname!
        $beforeOid: GitObjectID!
        $afterOid: GitObjectID!
        $force: Boolean!
      ) {
        updateRefs(
          input: {
            repositoryId: $repositoryId
            refUpdates: [{
              name: $name
              beforeOid: $beforeOid
              afterOid: $afterOid
              force: $force
            }]
          }
        ) {
          clientMutationId
        }
      }
    ' \
    -F repositoryId="$repository_id" \
    -f name="refs/tags/$major_tag" \
    -f beforeOid="$direct_before_oid" \
    -f afterOid="$update_sha" \
    -F force=true
  ;;
create)
  gh api --method POST "repos/$GITHUB_REPOSITORY/git/refs" \
    -f ref="refs/tags/$major_tag" -f sha="$update_sha"
  ;;
*)
  echo "Unable to determine a safe moving-tag update" >&2
  exit 1
  ;;
esac

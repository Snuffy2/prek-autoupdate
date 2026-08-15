#!/usr/bin/env bash
set -euo pipefail

if [[ ! "$RELEASE_TAG" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo "Release tag must have vMAJOR.MINOR.PATCH form" >&2
  exit 1
fi
major_tag="v${BASH_REMATCH[1]}"
readonly MAX_TAG_PEEL_DEPTH=16
if [[ ! "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Verified release SHA is invalid" >&2
  exit 1
fi

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
tags_file="$(mktemp)"
releases_file="$(mktemp)"
trap 'rm -f "$tags_file" "$releases_file"' EXIT

verify_point_tag() {
  local attempt depth direct_ref direct_oid object_oid object_type
  for attempt in 1 2 3 4 5; do
    if direct_ref="$(
      gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/$RELEASE_TAG" \
        --jq '.object | [.sha, .type] | @tsv' 2>/dev/null
    )"; then
      IFS=$'\t' read -r object_oid object_type <<< "$direct_ref"
      direct_oid="$object_oid"
      depth=0
      while [[ "$object_type" == "tag" && "$depth" -lt "$MAX_TAG_PEEL_DEPTH" ]]; do
        if ! direct_ref="$(
          gh api "repos/$GITHUB_REPOSITORY/git/tags/$object_oid" \
            --jq '.object | [.sha, .type] | @tsv' 2>/dev/null
        )"; then
          object_type=""
          break
        fi
        IFS=$'\t' read -r object_oid object_type <<< "$direct_ref"
        ((depth += 1))
      done
      if [[ "$object_type" == "tag" ]]; then
        echo "Annotated release tag exceeds maximum peel depth of $MAX_TAG_PEEL_DEPTH" >&2
        exit 1
      fi
      if [[ "$object_type" == "commit" && "$object_oid" == "$TARGET_SHA" ]]; then
        printf '%s\n' "$direct_oid"
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

release_direct_oid="$(verify_point_tag)"
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
  observed_release_oid="$(verify_point_tag)"
  if [[ "$observed_release_oid" != "$release_direct_oid" ]]; then
    echo "$RELEASE_TAG changed while its update was being prepared" >&2
    exit 1
  fi
  IFS=$'\t' read -r direct_before_oid direct_type < <(
    gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/$major_tag" \
      --jq '.object | [.sha, .type] | @tsv'
  )
  peeled_oid="$direct_before_oid"
  peeled_type="$direct_type"
  depth=0
  while [[ "$peeled_type" == "tag" && "$depth" -lt "$MAX_TAG_PEEL_DEPTH" ]]; do
    IFS=$'\t' read -r peeled_oid peeled_type < <(
      gh api "repos/$GITHUB_REPOSITORY/git/tags/$peeled_oid" \
        --jq '.object | [.sha, .type] | @tsv'
    )
    ((depth += 1))
  done
  if [[ "$peeled_type" == "tag" ]]; then
    echo "Annotated major tag exceeds maximum peel depth of $MAX_TAG_PEEL_DEPTH" >&2
    exit 1
  fi
  if [[ "$peeled_type" != "commit" || "$peeled_oid" != "$before_oid" ]]; then
    echo "$major_tag changed while its update was being prepared" >&2
    exit 1
  fi
  repository_id="$(gh api "repos/$GITHUB_REPOSITORY" --jq .node_id)"
  gh api graphql \
    -f query='
      mutation UpdateMajorTag(
        $repositoryId: ID!
        $releaseName: GitRefname!
        $releaseOid: GitObjectID!
        $majorName: GitRefname!
        $majorBeforeOid: GitObjectID!
        $majorAfterOid: GitObjectID!
      ) {
        updateRefs(
          input: {
            repositoryId: $repositoryId
            refUpdates: [
              {
                name: $releaseName
                beforeOid: $releaseOid
                afterOid: $releaseOid
                force: false
              }
              {
                name: $majorName
                beforeOid: $majorBeforeOid
                afterOid: $majorAfterOid
                force: true
              }
            ]
          }
        ) {
          clientMutationId
        }
      }
    ' \
    -F repositoryId="$repository_id" \
    -f releaseName="refs/tags/$RELEASE_TAG" \
    -f releaseOid="$observed_release_oid" \
    -f majorName="refs/tags/$major_tag" \
    -f majorBeforeOid="$direct_before_oid" \
    -f majorAfterOid="$update_sha"
  ;;
create)
  observed_release_oid="$(verify_point_tag)"
  if [[ "$observed_release_oid" != "$release_direct_oid" ]]; then
    echo "$RELEASE_TAG changed while its update was being prepared" >&2
    exit 1
  fi
  repository_id="$(gh api "repos/$GITHUB_REPOSITORY" --jq .node_id)"
  gh api graphql \
    -f query='
      mutation CreateMajorTag(
        $repositoryId: ID!
        $releaseName: GitRefname!
        $releaseOid: GitObjectID!
        $majorName: GitRefname!
        $majorAfterOid: GitObjectID!
      ) {
        updateRefs(
          input: {
            repositoryId: $repositoryId
            refUpdates: [
              {
                name: $releaseName
                beforeOid: $releaseOid
                afterOid: $releaseOid
                force: false
              }
              {
                name: $majorName
                beforeOid: "0000000000000000000000000000000000000000"
                afterOid: $majorAfterOid
                force: false
              }
            ]
          }
        ) {
          clientMutationId
        }
      }
    ' \
    -F repositoryId="$repository_id" \
    -f releaseName="refs/tags/$RELEASE_TAG" \
    -f releaseOid="$observed_release_oid" \
    -f majorName="refs/tags/$major_tag" \
    -f majorAfterOid="$update_sha"
  ;;
*)
  echo "Unable to determine a safe moving-tag update" >&2
  exit 1
  ;;
esac

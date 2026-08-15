#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Release source checkout must start clean" >&2
  exit 1
fi

node "$script_directory/prepare-release.mjs"
npm run build
npm run format:check
npm run lint
npm run typecheck
npm run test:coverage
git diff --check

allowed_paths=(
  "dist/index.js"
  "package-lock.json"
  "package.json"
)
changed_paths_output="$(git diff --name-only)"
untracked_paths_output="$(git ls-files --others --exclude-standard)"
mapfile -t changed_paths <<< "$changed_paths_output"
mapfile -t untracked_paths <<< "$untracked_paths_output"
for path in "${changed_paths[@]}" "${untracked_paths[@]}"; do
  [[ -z "$path" ]] && continue
  allowed=false
  for allowed_path in "${allowed_paths[@]}"; do
    if [[ "$path" == "$allowed_path" ]]; then
      allowed=true
      break
    fi
  done
  if [[ "$allowed" != true ]]; then
    echo "Release preparation changed unexpected path: $path" >&2
    exit 1
  fi
done

git add -- "${allowed_paths[@]}"
npm run check:dist

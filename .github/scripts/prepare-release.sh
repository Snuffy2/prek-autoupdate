#!/usr/bin/env bash
set -euo pipefail

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Release source checkout must start clean" >&2
  exit 1
fi

node .github/scripts/prepare-release.mjs
npm run build
npm run format:check
npm run lint
npm run typecheck
npm test
git diff --check

allowed_paths=(
  "dist/index.js"
  "package-lock.json"
  "package.json"
)
mapfile -t changed_paths < <(git diff --name-only)
mapfile -t untracked_paths < <(git ls-files --others --exclude-standard)
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

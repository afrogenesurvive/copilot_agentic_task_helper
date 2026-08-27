#!/usr/bin/env bash

set -u

repos_root="${1:-$HOME/Documents/GitHub}"
repos_seen=0
commands_run=0
commands_failed=0

if [[ ! -d "$repos_root" ]]; then
  printf 'Error: repository directory does not exist: %s\n' "$repos_root" >&2
  exit 1
fi

run_cleaner() {
  local label="$1"
  shift

  printf '  -> %s\n' "$label"
  if "$@"; then
    printf '  OK %s\n' "$label"
  else
    local status=$?
    printf '  FAILED (%d) %s\n' "$status" "$label" >&2
    ((commands_failed += 1))
  fi
  ((commands_run += 1))
}

printf 'Scanning Git repositories in: %s\n' "$repos_root"

while IFS= read -r -d '' git_marker; do
  repo="${git_marker%/.git}"
  ((repos_seen += 1))
  printf '\n[%d] %s\n' "$repos_seen" "$repo"

  pushd "$repo" >/dev/null || {
    printf '  SKIP Could not enter repository\n' >&2
    continue
  }

  repo_commands=0

  if [[ -f package.json ]]; then
    if command -v npm >/dev/null 2>&1; then
      run_cleaner 'npm cache clean --force' npm cache clean --force
      ((repo_commands += 1))
    else
      printf '  SKIP npm (command not installed)\n'
    fi
  else
    printf '  SKIP npm (no package.json)\n'
  fi

  if [[ -f yarn.lock ]]; then
    if command -v yarn >/dev/null 2>&1; then
      run_cleaner 'yarn cache clean' yarn cache clean
      ((repo_commands += 1))
    else
      printf '  SKIP Yarn (yarn.lock found, command not installed)\n'
    fi
  else
    printf '  SKIP Yarn (no yarn.lock)\n'
  fi

  if [[ -f angular.json ]]; then
    if [[ -x node_modules/.bin/ng ]]; then
      run_cleaner 'Angular cache clean (local CLI)' node_modules/.bin/ng cache clean
      ((repo_commands += 1))
    elif command -v ng >/dev/null 2>&1; then
      run_cleaner 'Angular cache clean (global CLI)' ng cache clean
      ((repo_commands += 1))
    else
      printf '  SKIP Angular (angular.json found, ng command not installed)\n'
    fi
  else
    printf '  SKIP Angular (no angular.json)\n'
  fi

  if ((repo_commands == 0)); then
    printf '  No applicable cache cleaners ran.\n'
  fi

  popd >/dev/null || exit 1
done < <(find "$repos_root" -mindepth 2 -maxdepth 2 -name .git \( -type d -o -type f \) -print0 | sort -z)

printf '\nSummary: %d repositories scanned, %d commands run, %d failures.\n' \
  "$repos_seen" "$commands_run" "$commands_failed"

if ((commands_failed > 0)); then
  exit 1
fi

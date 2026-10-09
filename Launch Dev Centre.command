#!/bin/bash
#
# Launch Dev Centre (development mode) — double-click this file in Finder.
#
# Runs `npm run electron:dev` from the repository this file sits in. Nothing here is
# machine-specific: the repo is resolved from the file's own location, and node/npm are
# looked up on PATH and then in the usual install places, because a double-clicked
# .command file does not inherit your shell's profile.
#
# First run only: if electron/node_modules is missing, it runs `npm run electron:install`
# before starting the app.
#
# Close the Terminal window, or press Ctrl-C, to stop the app.
#
# NOTE: this file is deliberately NOT tracked by git, so a `git clean -fd` will delete it.
# Recreate it with `git checkout` only if you have committed it; otherwise just ask for it
# to be regenerated.

set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO" || exit 1

printf '\033]0;Dev Centre (dev)\007'   # Terminal window title
echo "Dev Centre — development launcher"
echo "repo: $REPO"
echo

# ── Find node/npm ───────────────────────────────────────────────────────────────
# A .command launched from Finder gets a minimal PATH, so probe the common install
# locations before giving up. Same idea as electron/src/main/runtime.js uses at runtime.
if ! command -v npm >/dev/null 2>&1; then
  for dir in "$HOME"/.nvm/versions/node/*/bin /opt/homebrew/bin /usr/local/bin "$HOME"/.volta/bin; do
    if [ -x "$dir/npm" ]; then
      PATH="$dir:$PATH"
      echo "→ using npm from $dir"
      break
    fi
  done
  export PATH
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "❌ npm was not found on PATH." >&2
  echo "   Install Node.js (https://nodejs.org) or nvm, then double-click this again." >&2
  echo
  echo "Press Return to close this window."
  read -r _
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "❌ node was not found on PATH (npm is $(command -v npm))." >&2
  echo
  echo "Press Return to close this window."
  read -r _
  exit 1
fi

echo "→ node $(node --version) · npm $(npm --version)"
echo

# ── First run: install the Electron dependencies ────────────────────────────────
# `npm run electron:install` is `cd electron && npm install`; its postinstall patches the
# dev Electron bundle so the dock name and icon match the app.
if [ ! -d "$REPO/electron/node_modules/electron" ]; then
  echo "→ electron/node_modules is missing — running npm run electron:install"
  echo
  if ! npm run electron:install; then
    echo
    echo "❌ Installing the Electron dependencies failed (see above)." >&2
    echo "   A common cause is a half-installed Electron; try:" >&2
    echo "     cd electron && rm -rf node_modules/electron && npm install electron@33.4.11" >&2
    echo
    echo "Press Return to close this window."
    read -r _
    exit 1
  fi
  echo
fi

# ── Run the app ─────────────────────────────────────────────────────────────────
echo "→ npm run electron:dev"
echo "  (the dashboard opens; closing it hides it, quit from the menu bar or Cmd+Q)"
echo

npm run electron:dev
exit_code=$?

echo
if [ "$exit_code" -ne 0 ]; then
  echo "❌ Dev Centre exited with code $exit_code — the message above has the reason." >&2
  echo
  echo "Press Return to close this window."
  read -r _
fi

exit "$exit_code"

#!/bin/sh
# Install the formula for the archives in DIR through a throwaway tap, check
# the installed CLI, then remove it. Disposable CI runners only.
set -eu
test "${GITHUB_ACTIONS:-}" = true
dist=$(cd "$1" && pwd)
version=$(node -p 'require("./package.json").version')
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 HOMEBREW_NO_ANALYTICS=1
if brew list --formula docm >/dev/null 2>&1; then echo 'docm is already installed' >&2; exit 1; fi

HOMEBREW_DEVELOPER=1 brew tap-new --no-git docm/ci
trap 'brew uninstall --formula docm/ci/docm || true; brew untap docm/ci' EXIT
node scripts/formula.mjs "$dist" > "$(brew --repository docm/ci)/Formula/docm.rb"
brew install --formula docm/ci/docm

prefix=$(brew --prefix docm/ci/docm)
if [ "$(uname -s)" = Darwin ]; then
  # Homebrew must leave the ad-hoc signed bundle intact.
  codesign --verify --deep --strict "$prefix/libexec/Docm.app"
fi
"$(brew --prefix)/bin/docm" --version 2>&1 | grep -Fx "$version"
work=$(mktemp -d)
printf '# Homebrew install\n\nRendered by the installed formula.\n' > "$work/notes.md"
"$(brew --prefix)/bin/docm" r "$work/notes.md" -o "$work/notes.pdf"
test "$(head -c 5 "$work/notes.pdf")" = '%PDF-'

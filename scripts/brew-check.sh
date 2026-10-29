#!/bin/sh
# Install the formula for the archives in DIR through a throwaway tap, check
# the installed CLI, then remove it. Disposable CI runners only.
set -eu
test "${GITHUB_ACTIONS:-}" = true
dist=$(cd "$1" && pwd)
version=$(scripts/version.sh)
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 HOMEBREW_NO_ANALYTICS=1
if brew list --formula docm >/dev/null 2>&1; then echo 'docm is already installed' >&2; exit 1; fi

HOMEBREW_DEVELOPER=1 brew tap-new --no-git docm/ci
trap 'brew uninstall --formula docm/ci/docm || true; brew untap docm/ci' EXIT
python3 -I scripts/formula.py "$dist" > "$(brew --repository docm/ci)/Formula/docm.rb"
brew install --formula docm/ci/docm
brew test docm/ci/docm

PATH="$(brew --prefix)/bin:$PATH" scripts/smoke-installed.sh "$version"

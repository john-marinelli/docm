#!/bin/sh
# Install a Linux package from DIR and check it with smoke-installed.sh.
#   package-check.sh deb DIR   install the .deb on this (Ubuntu) runner
#   package-check.sh rpm DIR   install the .rpm in Fedora and openSUSE containers
# Disposable CI runners only.
set -eu
test "${GITHUB_ACTIONS:-}" = true
kind=$1
dist=$(cd "$2" && pwd)
scripts=$(cd "$(dirname "$0")" && pwd)
version=$("$scripts/version.sh")
rpm="/dist/docm-$version-linux-x64.rpm"

case "$kind" in
  deb)
    sudo apt-get install -y "$dist/docm-$version-linux-x64.deb"
    "$scripts/smoke-installed.sh" "$version"
    ;;
  rpm)
    for image in fedora:latest opensuse/tumbleweed:latest; do
      case "$image" in
        fedora:*) install="dnf install -y $rpm" ;;
        *) install="zypper --non-interactive install --allow-unsigned-rpm $rpm" ;;
      esac
      docker run --rm -v "$dist:/dist:ro" -v "$scripts:/scripts:ro" "$image" \
        sh -c "$install && /scripts/smoke-installed.sh $version"
    done
    ;;
  *)
    echo "Usage: package-check.sh deb|rpm DIR" >&2
    exit 2
    ;;
esac

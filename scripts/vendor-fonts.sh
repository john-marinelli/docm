#!/usr/bin/env bash
# Download the default prose/code fonts (SIL OFL 1.1) into crates/docm/fonts.
# Typst reads TrueType/OpenType only, so the OTF releases are used, not woff2.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
dest="$root/crates/docm/fonts"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fetch() { # NAME ZIP_URL LICENSE_URL
  curl -sSfL "$2" -o "$work/$1.zip"
  unzip -qo "$work/$1.zip" -d "$work/$1"
  mkdir -p "$dest/$1"
  find "$work/$1" -name '*.otf' -not -path '*__MACOSX*' -exec cp {} "$dest/$1/" \;
  curl -sSfL "$3" -o "$dest/$1/LICENSE.md"
}

fetch source-sans-3 \
  https://github.com/adobe-fonts/source-sans/releases/download/3.052R/OTF-source-sans-3.052R.zip \
  https://raw.githubusercontent.com/adobe-fonts/source-sans/3.052R/LICENSE.md
fetch source-code-pro \
  "https://github.com/adobe-fonts/source-code-pro/releases/download/2.042R-u/1.062R-i/1.026R-vf/OTF-source-code-pro-2.042R-u_1.062R-i.zip" \
  https://raw.githubusercontent.com/adobe-fonts/source-code-pro/release/LICENSE.md

#!/usr/bin/env bash
# Build the host's release artifacts into dist/:
#   macOS arm64: docm-VERSION-darwin-arm64.tar.gz
#   Linux x64:   docm-VERSION-linux-x64.tar.gz, .deb and .rpm
# The archives hold docm-VERSION/{bin/docm, share/doc/docm/...}; Homebrew
# installs from them. Cross-compilation is not supported.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
version="$(scripts/version.sh)"
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) target=darwin-arm64 ;;
  Linux-x86_64) target=linux-x64 ;;
  *) echo "Packaging supports only macOS arm64 and Linux x64" >&2; exit 1 ;;
esac

cargo build --release --locked --package docm
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p dist

# Shared layout: binary, reference theme, and third-party notices.
stage="$work/docm-$version"
mkdir -p "$stage/bin" "$stage/share/doc/docm"
install -m 0755 target/release/docm "$stage/bin/docm"
install -m 0644 defaults.toml "$stage/share/doc/docm/defaults.toml"
python3 -I scripts/notices.py "$stage/share/doc/docm/third-party"
cat > "$stage/share/doc/docm/copyright" <<EOF
docm $version
License: MIT
Third-party components and their licenses: third-party/index.tsv
EOF
archive="dist/docm-$version-$target.tar.gz"
tar -C "$work" -czf "$archive" "docm-$version"
echo "$archive" >&2

[[ "$target" == linux-x64 ]] || exit 0

# The binary links only libc/libm/libgcc_s; windowing libraries are loaded at
# runtime by the preview, so headless `docm r` works without them. Packages
# therefore recommend (not require) them.
glibc="$(objdump -T target/release/docm | grep -o 'GLIBC_[0-9.]*' | sed 's/GLIBC_//' | sort -V | tail -1)"
description="Markdown to PDF through Typst, with a native live preview"

deb="$work/deb"
mkdir -p "$deb/DEBIAN" "$deb/usr/bin" "$deb/usr/share/doc"
install -m 0755 target/release/docm "$deb/usr/bin/docm"
cp -R "$stage/share/doc/docm" "$deb/usr/share/doc/docm"
cat > "$deb/DEBIAN/control" <<EOF
Package: docm
Version: $version
Architecture: amd64
Maintainer: John Marinelli
Depends: libc6 (>= $glibc), libgcc-s1
Recommends: libegl1, libgl1, libwayland-client0, libwayland-egl1, libxkbcommon0, libxkbcommon-x11-0, libx11-6, libx11-xcb1, libxcursor1, libxrandr2, libxi6, xdg-desktop-portal
Section: text
Priority: optional
Homepage: https://github.com/john-marinelli/docm
Installed-Size: $(du -sk "$deb/usr" | cut -f1)
Description: $description
 Renders Markdown with LaTeX math and diagrams to PDF, offline, in a single
 binary. `docm FILE` opens a live preview window; `docm r FILE` renders
 without a display.
EOF
dpkg-deb --root-owner-group --build "$deb" "dist/docm-$version-linux-x64.deb" >&2

# rpmbuild generates the shared-library requirements (libc.so.6 versions)
# from the binary itself.
rpmtop="$work/rpm"
mkdir -p "$rpmtop/SPECS"
sed -e "s/@VERSION@/$version/g" -e "s|@STAGE@|$stage|g" -e "s|@SUMMARY@|$description|g" \
  packaging/linux/docm.spec.in > "$rpmtop/SPECS/docm.spec"
rpmbuild --quiet --define "_topdir $rpmtop" -bb "$rpmtop/SPECS/docm.spec"
cp "$rpmtop/RPMS/x86_64/docm-$version-1.x86_64.rpm" "dist/docm-$version-linux-x64.rpm"
echo "dist/docm-$version-linux-x64.deb dist/docm-$version-linux-x64.rpm" >&2

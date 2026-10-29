#!/usr/bin/env bash
# Download pinned Typst Universe packages, plus every @preview package they
# import, into crates/docm/packages/preview/NAME/VERSION. docm embeds that tree
# and never downloads packages at render time.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
dest="$root/crates/docm/packages/preview"
# Directly used packages. Keep in sync with crates/docm/src/diagram.rs.
pinned=(fletcher:0.5.8 chronos:0.3.0 timeliney:0.4.0 cetz:0.5.3 cetz-plot:0.1.4 diagraph:0.3.8 mitex:0.2.7)

queue=("${pinned[@]}")
seen=" "
while ((${#queue[@]})); do
  spec="${queue[0]}"; queue=("${queue[@]:1}")
  [[ "$seen" == *" $spec "* ]] && continue
  seen+="$spec "
  name="${spec%%:*}"; version="${spec##*:}"
  dir="$dest/$name/$version"
  if [[ ! -d "$dir" ]]; then
    echo "vendoring @preview/$name:$version" >&2
    mkdir -p "$dir"
    curl -sSfL "https://packages.typst.org/preview/$name-$version.tar.gz" | tar -xz -C "$dir"
  fi
  # Imports from bundled manuals, galleries and tests are not runtime dependencies.
  while read -r dep; do
    queue+=("$dep")
  done < <(grep -rhoE '@preview/[a-z0-9-]+:[0-9]+\.[0-9]+\.[0-9]+' "$dir" --include='*.typ' \
             --exclude-dir=docs --exclude-dir=doc --exclude-dir=manual --exclude-dir=gallery \
             --exclude-dir=examples --exclude-dir=tests --exclude-dir=template --exclude='manual*.typ' \
             | sed 's|@preview/||' | sort -u)
done
echo "vendored:$seen" >&2

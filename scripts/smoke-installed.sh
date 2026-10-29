#!/bin/sh
# Check the docm on PATH: version, then a display-less render with math and a
# Graphviz diagram. Usage: smoke-installed.sh EXPECTED_VERSION
set -eu
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
docm --version | grep -Fx "docm $1"
cat > "$work/notes.md" <<'MD'
# Installed docm

Inline $x^2$ math.

```diagraph
digraph { a -> b }
```
MD
env -u DISPLAY -u WAYLAND_DISPLAY docm r "$work/notes.md" -o "$work/notes.pdf"
test "$(head -c 5 "$work/notes.pdf")" = '%PDF-'
echo "docm $1 renders" >&2

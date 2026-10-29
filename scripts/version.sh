#!/usr/bin/env bash
# Print docm's version (the workspace version in Cargo.toml).
set -euo pipefail
cd "$(dirname "$0")/.."
cargo metadata --no-deps --format-version 1 --locked \
  | python3 -I -c 'import json, sys; print(next(p["version"] for p in json.load(sys.stdin)["packages"] if p["name"] == "docm"))'

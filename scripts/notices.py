#!/usr/bin/env python3
"""Collect third-party license notices for the docm binary into OUTDIR.

Usage: python3 -I scripts/notices.py OUTDIR

Includes every crate compiled into the binary for the host (normal
dependencies only, per `cargo tree`), the vendored Typst packages, and the
bundled fonts. Each component gets a directory holding its published
license/notice files; index.tsv lists name, version, and declared license.
"""

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NOTICE = re.compile(r"^(licen[cs]e|copying|copyright|notice)([._-].*)?$", re.IGNORECASE)


def cargo(*args):
    return subprocess.run(["cargo", *args], cwd=ROOT, check=True, capture_output=True, text=True).stdout


def copy_notices(source: Path, destination: Path) -> list:
    destination.mkdir(parents=True, exist_ok=True)
    copied = []
    for entry in sorted(source.iterdir()):
        if entry.is_file() and NOTICE.match(entry.name):
            shutil.copy2(entry, destination / entry.name)
            copied.append(entry.name)
    return copied


def main():
    if len(sys.argv) != 2:
        sys.exit("Usage: python3 -I scripts/notices.py OUTDIR")
    output = Path(sys.argv[1]).resolve()
    shutil.rmtree(output, ignore_errors=True)
    output.mkdir(parents=True)
    rows = []

    metadata = json.loads(cargo("metadata", "--format-version", "1", "--locked"))
    by_id = {(p["name"], p["version"]): p for p in metadata["packages"]}
    runtime = set()
    tree = cargo("tree", "--locked", "-p", "docm", "-e", "normal", "--prefix", "none", "--format", "{p}")
    for line in tree.splitlines():
        match = re.match(r"^(\S+) v(\S+)", line)
        if match and match.group(1) != "docm":
            runtime.add((match.group(1), match.group(2)))
    for name, version in sorted(runtime):
        package = by_id[(name, version)]
        directory = output / "crates" / f"{name}-{version}"
        copied = copy_notices(Path(package["manifest_path"]).parent, directory)
        rows.append(("crate", name, version, package.get("license") or "", " ".join(copied)))

    packages = ROOT / "crates" / "docm" / "packages" / "preview"
    for package in sorted(packages.iterdir()):
        for version in sorted(package.iterdir()):
            manifest = (version / "typst.toml").read_text()
            license = re.search(r'^license\s*=\s*"([^"]*)"', manifest, re.MULTILINE)
            copied = copy_notices(version, output / "typst-packages" / f"{package.name}-{version.name}")
            rows.append(("typst-package", package.name, version.name, license.group(1) if license else "", " ".join(copied)))

    for font in sorted((ROOT / "crates" / "docm" / "fonts").iterdir()):
        copied = copy_notices(font, output / "fonts" / font.name)
        rows.append(("font", font.name, "", "OFL-1.1", " ".join(copied)))

    with open(output / "index.tsv", "w") as index:
        index.write("kind\tname\tversion\tlicense\tfiles\n")
        for row in rows:
            index.write("\t".join(row) + "\n")
    (output / "README.txt").write_text(
        "docm is a single binary that bundles the Rust crates, Typst packages and fonts\n"
        "listed in index.tsv. Each directory holds the license and notice files that\n"
        "component publishes; components without such files are covered by the\n"
        "license expression declared in their metadata (index.tsv). Typst packages are\n"
        "bundled unmodified; Typst's own fonts are covered by typst-assets' NOTICE.\n"
    )
    missing = [row for row in rows if not row[4] and not row[3]]
    if missing:
        sys.exit(f"No license information for: {', '.join(row[1] for row in missing)}")
    print(f"Collected notices for {len(rows)} components in {output}", file=sys.stderr)


main()

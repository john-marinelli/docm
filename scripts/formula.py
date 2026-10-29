#!/usr/bin/env python3
"""Print the Homebrew formula for the release archives in DIR.

Usage: python3 -I scripts/formula.py DIR [--release OWNER/REPO]

Without --release the URLs are file:// URLs into DIR (for local and CI
installs); with it they point at the GitHub release, which then needs both
platform archives.
"""

import argparse
import hashlib
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TARGETS = [
    ("darwin-arm64", "on_macos", "depends_on arch: :arm64"),
    ("linux-x64", "on_linux", "depends_on arch: :x86_64"),
]


def ruby(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"').replace("#", "\\#") + '"'


def archive_name(version: str, target: str) -> str:
    return f"docm-{version}-{target}.tar.gz"


def render(version: str, homepage: str, archives: dict) -> str:
    blocks = []
    for target, block, requirement in TARGETS:
        if target not in archives:
            continue
        url, sha256 = archives[target]
        if not re.fullmatch(r"[0-9a-f]{64}", sha256):
            raise SystemExit(f"Invalid checksum for {target}")
        blocks.append(f"  {block} do\n    {requirement}\n    url {ruby(url)}\n    sha256 {ruby(sha256)}\n  end")
    if not blocks:
        raise SystemExit("The formula requires at least one platform archive")
    body = "\n\n".join(blocks)
    return f'''class Docm < Formula
  desc "Markdown to PDF through Typst, with a native live preview"
  homepage {ruby(homepage)}
  version {ruby(version)}
  license "MIT"

{body}

  def install
    bin.install "bin/docm"
    doc.install Dir["share/doc/docm/*"]
  end

  test do
    (testpath/"notes.md").write "# Homebrew\\n\\nInline $x^2$ math.\\n"
    system bin/"docm", "r", testpath/"notes.md", "-o", testpath/"notes.pdf"
    assert_equal "%PDF-", (testpath/"notes.pdf").binread(5)
  end
end
'''


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    parser.add_argument("--release", metavar="OWNER/REPO")
    args = parser.parse_args()
    version = subprocess.run([ROOT / "scripts" / "version.sh"], check=True, capture_output=True, text=True).stdout.strip()
    directory = args.directory.resolve()
    archives = {}
    for target, _, _ in TARGETS:
        file = directory / archive_name(version, target)
        if not file.exists():
            continue
        sha256 = hashlib.sha256(file.read_bytes()).hexdigest()
        if args.release:
            url = f"https://github.com/{args.release}/releases/download/v{version}/{file.name}"
        else:
            url = file.as_uri()
        archives[target] = (url, sha256)
    if args.release and len(archives) != len(TARGETS):
        names = " and ".join(archive_name(version, target) for target, _, _ in TARGETS)
        raise SystemExit(f"A release formula requires {names}")
    homepage = f"https://github.com/{args.release}" if args.release else "https://github.com/john-marinelli/docm"
    print(render(version, homepage, archives), end="")


main()

class Docm < Formula
  desc "Markdown to PDF through Typst, with a native live preview"
  homepage "https://github.com/john-marinelli/docm"
  version "0.3.0"
  license "MIT"

  on_macos do
    depends_on arch: :arm64
    url "https://github.com/john-marinelli/docm/releases/download/v0.3.0/docm-0.3.0-darwin-arm64.tar.gz"
    sha256 "9828a52cb81a6f07e755e66751666c45c4231eb03abbf44a48c9809c1f5fa807"
  end

  on_linux do
    depends_on arch: :x86_64
    url "https://github.com/john-marinelli/docm/releases/download/v0.3.0/docm-0.3.0-linux-x64.tar.gz"
    sha256 "25a540d0ef5f6730b46514e31a273a9b99c7832773c2485ffbbac41a62aa0bd4"
  end

  def install
    bin.install "bin/docm"
    doc.install Dir["share/doc/docm/*"]
  end

  test do
    (testpath/"notes.md").write "# Homebrew\n\nInline $x^2$ math.\n"
    system bin/"docm", "r", testpath/"notes.md", "-o", testpath/"notes.pdf"
    assert_equal "%PDF-", (testpath/"notes.pdf").binread(5)
  end
end

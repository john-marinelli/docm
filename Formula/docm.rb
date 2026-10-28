class Docm < Formula
  desc "Offline Markdown to PDF preview and rendering"
  homepage 'https://github.com/john-marinelli/docm'
  version '0.1.3'
  license "MIT"

  on_macos do
    depends_on macos: :ventura
    depends_on arch: :arm64
    preserve_rpath
    url 'https://github.com/john-marinelli/docm/releases/download/v0.1.3/docm-0.1.3-darwin-arm64.tar.gz'
    sha256 'ca5746fbdef34a9cf07d2fc42f60adc318f74bae70281634b77842d131834c4d'
  end

  on_linux do
    depends_on arch: :x86_64
    url 'https://github.com/john-marinelli/docm/releases/download/v0.1.3/docm-0.1.3-linux-x64.tar.gz'
    sha256 '0ea15928723e056c906e8755c9e104613c92b39885eb7937193608e57c42f805'
  end

  def install
    if OS.mac?
      # Homebrew unpacks into the archive's single Docm.app directory.
      (libexec/"Docm.app").install Dir["*"]
      bin.install_symlink libexec/"Docm.app/Contents/Resources/bin/docm"
    else
      libexec.install Dir["*"]
      bin.install_symlink libexec/"resources/bin/docm"
      (share/"applications/docm.desktop").write <<~EOS
        [Desktop Entry]
        Type=Application
        Name=Docm
        Comment=Offline Markdown to PDF
        Exec="#{opt_libexec}/docm" %f
        Terminal=false
        Categories=Office;Utility;
        MimeType=text/markdown;
      EOS
    end
  end

  def caveats
    return if OS.mac?

    <<~EOS
      Docm needs the Electron desktop libraries from your distribution
      (GTK 3, NSS, ALSA, libgbm, libdrm, AT-SPI, X11). The .deb and .rpm
      packages on the GitHub release install these and an AppArmor profile.
      Ubuntu 24.04+ requires an AppArmor profile permitting user namespaces
      for #{opt_libexec}/docm; see LLM_README.md.
    EOS
  end

  test do
    # Stdout is reserved for PDF bytes; the version goes to stderr.
    assert_match version.to_s, shell_output("#{bin}/docm --version 2>&1")
  end
end

class Docm < Formula
  desc "Offline Markdown to PDF desktop application"
  homepage 'https://github.com/john-marinelli/docm'
  url 'https://github.com/john-marinelli/docm/releases/download/v0.1.2/docm-0.1.2-source.tar.gz'
  version '0.1.2'
  sha256 '9d2f8a14c8235b0ba348630e83801055cf26d056a41bb2ffb2f767bad9f1f659'
  license "MIT"

  depends_on macos: :ventura
  depends_on arch: :arm64
  preserve_rpath

  resource 'pnpm-store' do
    url 'https://github.com/john-marinelli/docm/releases/download/v0.1.2/docm-0.1.2-pnpm-store.tar.gz'
    sha256 '2d00991b6b3d8076b1d5e464e0d075f10fe4c74f01539378850cd820b9d8cb79'
  end

  resource 'electron' do
    url 'https://github.com/john-marinelli/docm/releases/download/v0.1.2/docm-0.1.2-electron-darwin-arm64.tar.gz'
    sha256 'c0cafca293010723571196f771c7dc63c49511e7e18258230b816340c3caa419'
  end

  resource 'node' do
    url 'https://nodejs.org/dist/v26.10.0/node-v26.10.0-darwin-arm64.tar.xz'
    sha256 'f222f7e85cc1d5a3d84786aa86836ec3d41c4dcdf59a40e4a9d719b6b0ae28af'
  end

  resource 'pnpm' do
    url 'https://registry.npmjs.org/@pnpm/exe.darwin-arm64/-/exe.darwin-arm64-12.10.1.tgz'
    sha256 '706cb8ce6a7db1990adac82bbee873368163caf1a97398853e57cb40dbf4a488'
  end

  deny_network_access!

  def install
    resource("pnpm-store").stage(buildpath/".formula-store")
    resource("electron").stage(buildpath/".formula-electron")
    resource("node").stage(buildpath/".formula-node")
    resource("pnpm").stage(buildpath/".formula-pnpm")
    (buildpath/".formula-pnpm/pnpm").chmod 0755
    ENV.prepend_path "PATH", buildpath/".formula-node/bin"
    ENV.prepend_path "PATH", buildpath/".formula-pnpm"
    ENV["DOCM_FORMULA_STORE"] = (buildpath/".formula-store").to_s
    ENV["DOCM_FORMULA_ELECTRON"] = (buildpath/".formula-electron").to_s
    ENV["ELECTRON_SKIP_BINARY_DOWNLOAD"] = "1"
    ENV["CSC_IDENTITY_AUTO_DISCOVERY"] = "false"
    system "pnpm", "run", "formula:build"
    libexec.install "dist/mac-arm64/Docm.app"
    (libexec/"docm-source-receipt.json").write '{"schema":1,"name":"docm","version":"0.1.2","tag":"v0.1.2","repository":"john-marinelli/docm","commit":"e90353e420f761dae94e31617babea8a72f21260","tools":{"node":"26.10.0","pnpm":"12.10.1"},"platform":{"os":"darwin","arch":"arm64"},"assets":[{"name":"source","filename":"docm-0.1.2-source.tar.gz","sha256":"9d2f8a14c8235b0ba348630e83801055cf26d056a41bb2ffb2f767bad9f1f659"},{"name":"pnpm-store","filename":"docm-0.1.2-pnpm-store.tar.gz","sha256":"2d00991b6b3d8076b1d5e464e0d075f10fe4c74f01539378850cd820b9d8cb79"},{"name":"electron","filename":"docm-0.1.2-electron-darwin-arm64.tar.gz","sha256":"c0cafca293010723571196f771c7dc63c49511e7e18258230b816340c3caa419"}],"toolResources":[{"name":"node","url":"https://nodejs.org/dist/v26.10.0/node-v26.10.0-darwin-arm64.tar.xz","sha256":"f222f7e85cc1d5a3d84786aa86836ec3d41c4dcdf59a40e4a9d719b6b0ae28af"},{"name":"pnpm","url":"https://registry.npmjs.org/@pnpm/exe.darwin-arm64/-/exe.darwin-arm64-12.10.1.tgz","sha256":"706cb8ce6a7db1990adac82bbee873368163caf1a97398853e57cb40dbf4a488"}]}
'
    bin.install_symlink libexec/"Docm.app/Contents/Resources/bin/docm"
  end

  def caveats
    <<~EOS
      This source build uses an upstream prebuilt Electron runtime.
      Docm.app has only an ad-hoc signature, not Developer ID/notarization.
      No quarantine, Gatekeeper, sandbox or other macOS protection is bypassed.
      Pinned Node/pnpm are staged from checksummed official build resources.
    EOS
  end

  test do
    (testpath/"home").mkpath
    ENV["HOME"] = (testpath/"home").to_s
    (testpath/"notes.md").write "# Source-built docm\n\nOffline formula test.\n"
    system bin/"docm", "r", testpath/"notes.md", "-o", testpath/"notes.pdf"
    assert_equal "%PDF-", (testpath/"notes.pdf").binread(5)
  end
end

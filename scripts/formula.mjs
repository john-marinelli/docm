import {platformKey} from './platform.mjs';
import {validateTag} from './version.mjs';

const ruby = value => `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}(?![\s\S])/.test(value);

// Local ownership-managed builds and public releases share the same native recipe.
export function renderFormula({version, homepage, targets, receipt}) {
  validateTag(`v${version}`, version);
  const url = value => typeof value === 'string' && /^(?:https:\/\/|file:\/\/)/.test(value) && !/[\r\n\0]/.test(value);
  if (!url(homepage)) throw new Error('Invalid formula homepage');
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > 2) throw new Error('Formula requires one or two native targets');
  const seen = new Set();
  for (const {platform, source, resources} of targets) {
    const key = platformKey(platform);
    if (seen.has(key)) throw new Error(`Duplicate formula target: ${key}`);
    seen.add(key);
    if (!source || !url(source.url) || !hash(source.sha256)) throw new Error('Invalid formula source');
    if (!Array.isArray(resources) || resources.length !== 4 || resources.map(item => item?.name).sort().join(',') !== 'electron,node,pnpm,pnpm-store') throw new Error('Formula requires electron, node, pnpm and pnpm-store resources');
    for (const item of resources) if (!url(item.url) || !hash(item.sha256)) throw new Error(`Invalid formula resource: ${item.name}`);
  }
  const blocks = [...targets].sort((a, b) => a.platform.os.localeCompare(b.platform.os)).map(({platform, source, resources}) => {
    const mac = platform.os === 'darwin';
    const requirements = mac ? '    depends_on macos: :ventura\n    depends_on arch: :arm64\n    preserve_rpath' : '    depends_on arch: :x86_64';
    const resourceBlocks = resources.map(item => `    resource ${ruby(item.name)} do\n      url ${ruby(item.url)}\n      sha256 ${ruby(item.sha256)}\n    end`).join('\n\n');
    return `  on_${mac ? 'macos' : 'linux'} do\n${requirements}\n    url ${ruby(source.url)}\n    sha256 ${ruby(source.sha256)}\n\n${resourceBlocks}\n  end`;
  }).join('\n\n');
  return `class Docm < Formula
  desc "Offline Markdown to PDF desktop application"
  homepage ${ruby(homepage)}
  version ${ruby(version)}
  license "MIT"
${targets.length === 1 ? `  depends_on :${targets[0].platform.os === 'darwin' ? 'macos' : 'linux'}\n` : ''}
${blocks}

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
    if OS.mac?
      libexec.install "dist/mac-arm64/Docm.app"
      bin.install_symlink libexec/"Docm.app/Contents/Resources/bin/docm"
    else
      (libexec/"docm-linux").install Dir["dist/linux-unpacked/*"]
      bin.install_symlink libexec/"docm-linux/resources/bin/docm"
      (share/"applications").mkpath
      (share/"applications/docm.desktop").write <<~EOS
        [Desktop Entry]
        Type=Application
        Name=Docm
        Comment=Offline Markdown to PDF
        Exec="#{opt_libexec}/docm-linux/docm" %F
        Terminal=false
        Categories=Office;Utility;
        MimeType=text/markdown;
      EOS
    end
    (libexec/"docm-source-receipt.json").write ${ruby(JSON.stringify(receipt) + '\n')}
  end

  def caveats
    text = <<~EOS
      This source build uses an upstream prebuilt Electron runtime.
      Pinned Node/pnpm are staged from checksummed official build resources.
    EOS
    if OS.mac?
      text += <<~EOS
        Docm.app has only an ad-hoc signature, not Developer ID/notarization.
        No quarantine, Gatekeeper, sandbox or other macOS protection is bypassed.
      EOS
    else
      text += <<~EOS
        Linux support targets Ubuntu 24.04 LTS x86_64 (glibc 2.39+) with a desktop session.
        The host must provide GTK 3, NSS, ALSA, libgbm, libdrm, AT-SPI and X11 libraries.
        On Ubuntu 24.04: apt install libgtk-3-0t64 libnss3 libasound2t64 libgbm1 libdrm2 libatk-bridge2.0-0t64 libx11-xcb1 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 xdg-utils
        Electron's sandbox requires permitted unprivileged user namespaces.
        Ubuntu 24.04+ may require an administrator-provided AppArmor policy.
        No sandbox protection is disabled by this formula or its launcher.
      EOS
    end
    text
  end

  test do
    (testpath/"home").mkpath
    ENV["HOME"] = (testpath/"home").to_s
    (testpath/"notes.md").write "# Source-built docm\\n\\nOffline formula test.\\n"
    system bin/"docm", "r", testpath/"notes.md", "-o", testpath/"notes.pdf"
    assert_equal "%PDF-", (testpath/"notes.pdf").binread(5)
  end
end
`;
}

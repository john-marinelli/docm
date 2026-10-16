import {validateTag} from './version.mjs';

const ruby = value => `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}(?![\s\S])/.test(value);

// Both local ownership-managed builds and public release builds use this recipe.
// The caller supplies its provenance descriptor; the renderer never invents paths.
export function renderFormula({version, homepage, source, resources, receipt}) {
  validateTag(`v${version}`, version);
  const url = value => typeof value === 'string' && /^(?:https:\/\/|file:\/\/)/.test(value) && !/[\r\n\0]/.test(value);
  if (!url(homepage) || !source || !url(source.url) || !hash(source.sha256)) throw new Error('Invalid formula source/homepage');
  if (!Array.isArray(resources) || resources.length !== 4 || resources.map(item => item?.name).sort().join(',') !== 'electron,node,pnpm,pnpm-store') throw new Error('Formula requires electron, node, pnpm and pnpm-store resources');
  for (const item of resources) if (!url(item.url) || !hash(item.sha256)) throw new Error(`Invalid formula resource: ${item.name}`);
  const blocks = resources.map(item => `  resource ${ruby(item.name)} do\n    url ${ruby(item.url)}\n    sha256 ${ruby(item.sha256)}\n  end\n`).join('\n');
  return `class Docm < Formula
  desc "Offline Markdown to PDF desktop application"
  homepage ${ruby(homepage)}
  url ${ruby(source.url)}
  version ${ruby(version)}
  sha256 ${ruby(source.sha256)}
  license "MIT"

  depends_on macos: :ventura
  depends_on arch: :arm64
  preserve_rpath

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
    libexec.install "dist/mac-arm64/Docm.app"
    (libexec/"docm-source-receipt.json").write ${ruby(JSON.stringify(receipt) + '\n')}
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
    (testpath/"notes.md").write "# Source-built docm\\n\\nOffline formula test.\\n"
    system bin/"docm", "r", testpath/"notes.md", "-o", testpath/"notes.pdf"
    assert_equal "%PDF-", (testpath/"notes.pdf").binread(5)
  end
end
`;
}

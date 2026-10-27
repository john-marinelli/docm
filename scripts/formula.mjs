import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';

const root=path.resolve(import.meta.dirname,'..');
const ruby=value=>`'${value.replaceAll('\\','\\\\').replaceAll("'","\\'")}'`;
const targets=[
  {key:'darwin-arm64',block:'on_macos',requirements:['depends_on macos: :ventura','depends_on arch: :arm64','preserve_rpath']},
  {key:'linux-x64',block:'on_linux',requirements:['depends_on arch: :x86_64']},
];
export const archiveName=(version,key)=>`docm-${version}-${key}.tar.gz`;

// One recipe installs the prebuilt electron-builder archive for each platform.
// `archives` maps a platform key to {url, sha256}; absent platforms are omitted.
export function renderFormula({version,homepage,archives}){
  const blocks=targets.filter(target=>archives[target.key]).map(({key,block,requirements})=>{
    const {url,sha256}=archives[key];
    if(!/^[a-f0-9]{64}$/.test(sha256))throw new Error(`Invalid checksum for ${key}`);
    return `  ${block} do\n${requirements.map(line=>`    ${line}\n`).join('')}    url ${ruby(url)}\n    sha256 ${ruby(sha256)}\n  end`;
  });
  if(!blocks.length)throw new Error('The formula requires at least one platform archive');
  return `class Docm < Formula
  desc "Offline Markdown to PDF preview and rendering"
  homepage ${ruby(homepage)}
  version ${ruby(version)}
  license "MIT"

${blocks.join('\n\n')}

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
`;
}

async function sha256(file){return createHash('sha256').update(await readFile(file)).digest('hex');}

// node scripts/formula.mjs DIR              file:// URLs to archives in DIR
// node scripts/formula.mjs DIR --release R  GitHub release URLs for OWNER/REPO R
async function main(){
  const {values,positionals}=parseArgs({allowPositionals:true,options:{release:{type:'string'}}});
  if(positionals.length!==1)throw new Error('Usage: node scripts/formula.mjs DIR [--release OWNER/REPO]');
  const directory=path.resolve(positionals[0]);
  const {version}=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
  const archives={};
  for(const {key} of targets){
    const name=archiveName(version,key),file=path.join(directory,name);
    let checksum;
    try{checksum=await sha256(file);}catch(error){if(error.code==='ENOENT')continue;throw error;}
    archives[key]={sha256:checksum,url:values.release?`https://github.com/${values.release}/releases/download/v${version}/${name}`:pathToFileURL(file).href};
  }
  if(values.release&&Object.keys(archives).length!==targets.length)throw new Error(`A release formula requires ${targets.map(target=>archiveName(version,target.key)).join(' and ')}`);
  process.stdout.write(renderFormula({version,homepage:values.release?`https://github.com/${values.release}`:'https://github.com/john-marinelli/docm',archives}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{await main();}catch(error){console.error(error.message);process.exitCode=1;}
}

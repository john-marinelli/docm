import {constants} from 'node:fs';
import {copyFile,lstat,mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fileDigest,prepare,root} from './prepare-formula.mjs';
import {renderFormula} from './formula.mjs';
import {readVersion,validateTag} from './version.mjs';

const assetNames=['source','pnpm-store','electron'];
const metadataNames=['release-manifest.json','docm.rb'];
const validHash=value=>typeof value==='string'&&/^[a-f0-9]{64}(?![\s\S])/.test(value);
const json=value=>JSON.stringify(value,null,2)+'\n';
function exact(value,keys,label){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==[...keys].sort().join(','))throw new Error(`Invalid ${label} fields`);
}
export function validateRepository(repository){
  if(typeof repository!=='string'||!repository.split('/').every(part=>/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?(?![\s\S])/.test(part))||repository.split('/').length!==2)throw new Error('Repository must be an OWNER/REPO GitHub name');
  return repository;
}
function validateIdentity({tag,version,repository,commit}){
  validateTag(tag,version);
  validateRepository(repository);
  if(typeof commit!=='string'||!(/^[a-f0-9]{40}(?![\s\S])/i).test(commit))throw new Error('Release commit must be a full 40-character hexadecimal commit');
}
function filename(name,version){
  return `docm-${version}-${name==='electron'?'electron-darwin-arm64':name}.tar.gz`;
}
function validateManifest(manifest){
  exact(manifest,['schema','name','version','tag','repository','commit','tools','platform','assets','toolResources'],'release manifest');
  if(manifest.schema!==1||manifest.name!=='docm')throw new Error('Unsupported release manifest schema/name');
  validateIdentity(manifest);
  exact(manifest.platform,['os','arch'],'platform');
  if(manifest.platform.os!=='darwin'||manifest.platform.arch!=='arm64')throw new Error('Release platform must be darwin arm64');
  exact(manifest.tools,['node','pnpm'],'tools');
  for(const version of Object.values(manifest.tools))validateTag(`v${version}`,version);
  if(!Array.isArray(manifest.assets)||manifest.assets.length!==3||manifest.assets.map(item=>item?.name).join(',')!==assetNames.join(','))throw new Error('Release requires exactly source, pnpm-store and electron assets in order');
  for(const asset of manifest.assets){
    exact(asset,['name','filename','sha256'],'asset');
    if(asset.filename!==filename(asset.name,manifest.version)||!validHash(asset.sha256))throw new Error(`Invalid asset filename/checksum: ${asset.name}`);
  }
  const urls={node:`https://nodejs.org/dist/v${manifest.tools.node}/node-v${manifest.tools.node}-darwin-arm64.tar.xz`,pnpm:`https://registry.npmjs.org/pnpm/-/pnpm-${manifest.tools.pnpm}.tgz`};
  if(!Array.isArray(manifest.toolResources)||manifest.toolResources.length!==2||manifest.toolResources.map(item=>item?.name).join(',')!=='node,pnpm')throw new Error('Release requires exactly official node and pnpm resources in order');
  for(const resource of manifest.toolResources){
    exact(resource,['name','url','sha256'],'tool resource');
    if(resource.url!==urls[resource.name]||!validHash(resource.sha256))throw new Error(`Invalid official tool resource: ${resource.name}`);
  }
  return manifest;
}
function releaseFormula(manifest){
  const base=`https://github.com/${manifest.repository}/releases/download/${manifest.tag}/`;
  const [source,...assets]=manifest.assets.map(asset=>({name:asset.name,url:base+asset.filename,sha256:asset.sha256}));
  // The entire receipt is portable: it contains no source checkout, cache or tap paths.
  return renderFormula({version:manifest.version,homepage:`https://github.com/${manifest.repository}`,source,resources:[...assets,...manifest.toolResources],receipt:manifest});
}
async function regular(file){
  const info=await lstat(file);
  if(!info.isFile()||info.isSymbolicLink()||info.size===0)throw new Error(`Release input must be a nonempty regular file: ${file}`);
  return info;
}
function releaseFiles(manifest){return [...manifest.assets.map(asset=>asset.filename),...metadataNames];}
async function checksums(directory,files){
  const lines=[];
  for(const name of files){await regular(path.join(directory,name));lines.push(`${await fileDigest(path.join(directory,name))}  ${name}\n`);}
  return lines.join('');
}

// This consumer boundary also allows deterministic isolated tests with tiny assets.
// Production callers obtain frozen inputs only through prepareRelease below.
export async function assembleRelease(frozen,{tag,commit,repository,output=path.join(root,'.build','release')}){
  validateIdentity({tag,commit,repository,version:frozen.version});
  if(!Array.isArray(frozen.resources)||frozen.resources.length!==2||frozen.resources.map(item=>item?.name).sort().join(',')!=='electron,pnpm-store')throw new Error('Frozen inputs require electron and pnpm-store');
  const originals=[frozen.source,...['pnpm-store','electron'].map(name=>frozen.resources.find(item=>item.name===name))];
  const manifest=validateManifest({schema:1,name:'docm',version:frozen.version,tag,repository,commit,tools:{...frozen.tools},platform:{os:'darwin',arch:'arm64'},assets:assetNames.map((name,index)=>({name,filename:filename(name,frozen.version),sha256:originals[index]?.sha256})),toolResources:frozen.toolResources?.map(item=>({...item}))});
  // Verify all inputs before creating any output. Never trust the cache receipt alone.
  for(const item of originals){
    if(typeof item?.archive!=='string'||!path.isAbsolute(item.archive))throw new Error('Frozen asset requires an absolute archive path');
    await regular(item.archive);
    if(await fileDigest(item.archive)!==item.sha256)throw new Error(`Frozen asset checksum differs: ${item.archive}`);
  }
  const destination=path.resolve(output);
  await mkdir(destination,{recursive:true});
  if(!(await lstat(destination)).isDirectory()||(await lstat(destination)).isSymbolicLink())throw new Error('Release output must be an actual directory');
  if((await readdir(destination)).length)throw new Error(`Release output is not empty: ${destination}; use --output with a fresh directory`);
  for(const [index,asset] of manifest.assets.entries()){
    const target=path.join(destination,asset.filename);
    await copyFile(originals[index].archive,target,constants.COPYFILE_EXCL);
    if((await lstat(target)).size!==(await lstat(originals[index].archive)).size||await fileDigest(target)!==asset.sha256)throw new Error(`Release asset changed while copying: ${asset.filename}`);
  }
  await writeFile(path.join(destination,'release-manifest.json'),json(manifest),{flag:'wx'});
  await writeFile(path.join(destination,'docm.rb'),releaseFormula(manifest),{flag:'wx'});
  await writeFile(path.join(destination,'SHA256SUMS'),await checksums(destination,releaseFiles(manifest)),{flag:'wx'});
  return manifest;
}

export async function prepareRelease({tag,commit,repository,output}={}){
  validateIdentity({tag,commit,repository,version:await readVersion()});
  return assembleRelease(await prepare(),{tag,commit,repository,output});
}

export async function verifyRelease(directory){
  const destination=path.resolve(directory);
  const info=await lstat(destination);
  if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Release must be an actual directory');
  await regular(path.join(destination,'release-manifest.json'));
  const manifest=validateManifest(JSON.parse(await readFile(path.join(destination,'release-manifest.json'),'utf8')));
  const files=releaseFiles(manifest);
  if((await readdir(destination)).sort().join(',')!==[...files,'SHA256SUMS'].sort().join(','))throw new Error('Release directory contains missing or unexpected files');
  await regular(path.join(destination,'SHA256SUMS'));
  if(await readFile(path.join(destination,'SHA256SUMS'),'utf8')!==await checksums(destination,files))throw new Error('Release SHA256SUMS mismatch');
  for(const asset of manifest.assets)if(await fileDigest(path.join(destination,asset.filename))!==asset.sha256)throw new Error(`Release asset checksum mismatch: ${asset.filename}`);
  if(await readFile(path.join(destination,'docm.rb'),'utf8')!==releaseFormula(manifest))throw new Error('Release formula does not match manifest');
  return manifest;
}

async function main(){
  const [command,...args]=process.argv.slice(2);
  if(command!=='prepare')throw new Error('Usage: node scripts/release.mjs prepare --tag vX.Y.Z --commit FULL40HEX --repository OWNER/REPO [--output DIR]');
  const options={};
  for(let index=0;index<args.length;index+=2){
    const flag=args[index];
    if(!['--tag','--commit','--repository','--output'].includes(flag)||!args[index+1]||args[index+1].startsWith('--')||Object.hasOwn(options,flag.slice(2)))throw new Error(`Invalid or repeated release option: ${flag}`);
    options[flag.slice(2)]=args[index+1];
  }
  const manifest=await prepareRelease(options);
  console.error(`Prepared ${manifest.tag} in ${path.resolve(options.output??path.join(root,'.build','release'))}`);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{await main();}catch(error){console.error(error.message);process.exitCode=1;}
}
